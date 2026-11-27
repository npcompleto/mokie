import {
  BackendInputSchema,
  CollectionInputSchema,
  ExportBundleSchema,
  FlowPageInputSchema,
  MockInputSchema,
  type ExportBundle,
} from '@mokie/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, type ZodType } from 'zod';
import { tx } from '../db/index.ts';
import type { Mokie } from '../app.ts';
import { checkSyntax } from '../engine/sandbox.ts';
import { validateTemplate } from '../engine/template.ts';
import { trafficToMock } from '../traffic/toMock.ts';
import { isTextual } from '../engine/request.ts';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function body<T>(schema: ZodType<T, any, any>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'Dati non validi', r.error.issues);
  return r.data;
}
const idParam = (p: unknown) => {
  const id = Number((p as { id: string }).id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'id non valido');
  return id;
};
const found = <T>(v: T | undefined, what = 'Risorsa'): T => {
  if (v === undefined) throw new HttpError(404, `${what} non trovata`);
  return v;
};

export function registerAdminRoutes(app: FastifyInstance, m: Mokie) {
  const { repos, state, engine, bus } = m;
  const changed = (what: string) => bus.emit('config', what);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    const msg = (err as Error).message ?? String(err);
    if (/UNIQUE constraint/i.test(msg)) return reply.code(409).send({ error: 'Valore duplicato', details: msg });
    reply.code((err as any).statusCode ?? 500).send({ error: msg });
  });

  // ---------- health / settings ----------
  app.get('/api/health', async () => ({ ok: true, port: m.config.port }));
  app.get('/api/settings', async () => repos.getSettings());
  app.put('/api/settings', async (req) => {
    const s = body(
      z.object({
        publicUrl: z.string().optional(),
        trafficRetention: z.number().int().min(0).optional(),
        maxBodyBytes: z.number().int().min(1024).optional(),
        noBackendFallback: z.enum(['notFound', 'badGateway']).optional(),
      }),
      req.body,
    );
    const r = repos.updateSettings(s);
    changed('settings');
    return r;
  });

  // ---------- backends ----------
  app.get('/api/backends', async () => repos.listBackends());
  app.post('/api/backends', async (req) => {
    const r = repos.createBackend(body(BackendInputSchema, req.body));
    changed('backends');
    return r;
  });
  app.put('/api/backends/:id', async (req) => {
    const r = found(repos.updateBackend(idParam(req.params), body(BackendInputSchema, req.body)), 'Backend');
    changed('backends');
    return r;
  });
  app.delete('/api/backends/:id', async (req) => {
    repos.deleteBackend(idParam(req.params));
    changed('backends');
    return { ok: true };
  });

  // ---------- collections ----------
  app.get('/api/collections', async () => repos.listCollections());
  app.post('/api/collections', async (req) => {
    const r = repos.createCollection(body(CollectionInputSchema, req.body));
    changed('collections');
    return r;
  });
  app.put('/api/collections/:id', async (req) => {
    const r = found(repos.updateCollection(idParam(req.params), body(CollectionInputSchema, req.body)), 'Collection');
    changed('collections');
    return r;
  });
  app.delete('/api/collections/:id', async (req) => {
    repos.deleteCollection(idParam(req.params));
    changed('collections');
    return { ok: true };
  });

  // ---------- mocks ----------
  const validateMock = (mk: z.infer<typeof MockInputSchema>) => {
    const errors: string[] = [];
    const t = validateTemplate(mk.response.body);
    if (t) errors.push(`Template risposta: ${t}`);
    if (mk.script.trim()) {
      const s = checkSyntax(mk.script);
      if (s) errors.push(`Script: ${s}`);
    }
    if (mk.pathPattern.startsWith('^')) {
      try {
        new RegExp(mk.pathPattern);
      } catch (e) {
        errors.push(`Path regex: ${(e as Error).message}`);
      }
    }
    if (errors.length) throw new HttpError(400, errors.join('\n'), errors);
    return mk;
  };
  app.get('/api/mocks', async () => repos.listMocks());
  app.get('/api/mocks/:id', async (req) => found(repos.getMock(idParam(req.params)), 'Mock'));
  app.post('/api/mocks', async (req) => {
    const r = repos.createMock(validateMock(body(MockInputSchema, req.body)));
    changed('mocks');
    return r;
  });
  app.put('/api/mocks/:id', async (req) => {
    const r = found(repos.updateMock(idParam(req.params), validateMock(body(MockInputSchema, req.body))), 'Mock');
    changed('mocks');
    return r;
  });
  app.patch('/api/mocks/:id/enabled', async (req) => {
    const { enabled } = body(z.object({ enabled: z.boolean() }), req.body);
    const r = found(repos.setMockEnabled(idParam(req.params), enabled), 'Mock');
    changed('mocks');
    return r;
  });
  app.post('/api/mocks/:id/duplicate', async (req) => {
    const src = found(repos.getMock(idParam(req.params)), 'Mock');
    const { id, createdAt, updatedAt, ...rest } = src;
    const r = repos.createMock({ ...rest, name: `${src.name} (copia)` });
    changed('mocks');
    return r;
  });
  app.delete('/api/mocks/:id', async (req) => {
    repos.deleteMock(idParam(req.params));
    changed('mocks');
    return { ok: true };
  });
  /** Dry run: which mock would answer this request, and why. */
  app.post('/api/mocks/explain', async (req) => {
    const r = body(
      z.object({
        method: z.string().default('GET'),
        url: z.string().default('/'),
        headers: z.record(z.string()).default({}),
        body: z.string().default(''),
      }),
      req.body,
    );
    return engine.explain({ method: r.method, url: r.url, headers: r.headers, rawBody: Buffer.from(r.body) });
  });
  /**
   * Real call: the request goes through the same pipeline as the proxy port
   * (mock or backend, state effects applied, recorded in traffic).
   */
  app.post('/api/mocks/call', async (req) => {
    const r = body(
      z.object({
        method: z.string().default('GET'),
        url: z.string().startsWith('/').default('/'),
        headers: z.record(z.string()).default({}),
        body: z.string().default(''),
      }),
      req.body,
    );
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) headers[k.toLowerCase()] = v;
    // same host the admin is reached on: generated flow URLs are then directly openable
    headers.host ??= req.headers.host ?? `localhost:${m.config.port}`;
    const started = performance.now();
    const out = await engine.handle({ method: r.method.toUpperCase(), url: r.url, headers, rawBody: Buffer.from(r.body), remoteAddress: req.ip });
    const resHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.headers)) resHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    const buf = out.logBody ?? out.body;
    return {
      status: out.status,
      headers: resHeaders,
      body: isTextual(resHeaders['content-type']) ? buf.toString('utf8') : `[binary ${buf.length} bytes]`,
      source: out.source,
      mockId: out.mockId ?? null,
      note: out.note ?? '',
      durationMs: Math.round(performance.now() - started),
    };
  });

  // ---------- state ----------
  app.get('/api/state', async () => state.all());
  app.put('/api/state', async (req) => {
    const v = req.body;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Lo stato deve essere un oggetto JSON');
    state.replaceAll(v as Record<string, unknown>);
    return state.all();
  });
  app.put('/api/state/key', async (req) => {
    const { path, value } = body(z.object({ path: z.string().min(1), value: z.unknown() }), req.body);
    state.set(path, value);
    return state.all();
  });
  app.delete('/api/state/key', async (req) => {
    const { path } = body(z.object({ path: z.string().min(1) }), req.query);
    state.remove(path);
    return state.all();
  });
  app.delete('/api/state', async () => {
    state.replaceAll({});
    return {};
  });
  app.get('/api/state/snapshots', async () => state.listSnapshots());
  app.post('/api/state/snapshots', async (req) => {
    const { name } = body(z.object({ name: z.string().min(1) }), req.body);
    return { id: state.saveSnapshot(name) };
  });
  app.post('/api/state/snapshots/:id/restore', async (req) => {
    if (!state.restoreSnapshot(idParam(req.params))) throw new HttpError(404, 'Snapshot non trovato');
    return state.all();
  });
  app.delete('/api/state/snapshots/:id', async (req) => {
    state.deleteSnapshot(idParam(req.params));
    return { ok: true };
  });

  // ---------- flow pages & sessions ----------
  app.get('/api/flow-pages', async () => repos.listFlowPages());
  app.post('/api/flow-pages', async (req) => {
    const r = repos.createFlowPage(body(FlowPageInputSchema, req.body));
    changed('flows');
    return r;
  });
  app.put('/api/flow-pages/:id', async (req) => {
    const r = found(repos.updateFlowPage(idParam(req.params), body(FlowPageInputSchema, req.body)), 'Pagina');
    changed('flows');
    return r;
  });
  app.delete('/api/flow-pages/:id', async (req) => {
    repos.deleteFlowPage(idParam(req.params));
    changed('flows');
    return { ok: true };
  });
  /** Create a test session (e.g. from the UI "Prova" button). */
  app.post('/api/flow-pages/:id/sessions', async (req) => {
    const page = found(repos.getFlowPage(idParam(req.params)), 'Pagina');
    const { context } = body(z.object({ context: z.record(z.unknown()).default({}) }), req.body ?? {});
    const base = repos.getSettings().publicUrl || `${req.protocol}://${req.headers.host ?? `localhost:${m.config.port}`}`;
    return engine.flows.createSession(page.slug, context, base.replace(/\/+$/, ''));
  });
  app.get('/api/flow-sessions', async () => repos.listSessions());
  app.delete('/api/flow-sessions', async () => {
    repos.clearSessions();
    return { ok: true };
  });

  // ---------- traffic ----------
  app.get('/api/traffic', async (req) => {
    const q = body(
      z.object({
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        beforeId: z.coerce.number().int().optional(),
        q: z.string().optional(),
        source: z.string().optional(),
      }),
      req.query,
    );
    return repos.listTraffic(q);
  });
  app.get('/api/traffic/:id', async (req) => found(repos.getTraffic(idParam(req.params)), 'Richiesta'));
  app.post('/api/traffic/:id/to-mock', async (req) => trafficToMock(found(repos.getTraffic(idParam(req.params)), 'Richiesta')));
  app.delete('/api/traffic', async () => {
    repos.clearTraffic();
    return { ok: true };
  });

  // ---------- live events (SSE) ----------
  app.get('/api/events', (req, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onTraffic = (t: unknown) => send('traffic', t);
    const onState = (keys: string[]) => send('state', keys);
    const onConfig = (what: string) => send('config', what);
    bus.on('traffic', onTraffic);
    bus.on('state', onState);
    bus.on('config', onConfig);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      bus.off('traffic', onTraffic);
      bus.off('state', onState);
      bus.off('config', onConfig);
    });
  });

  // ---------- import / export ----------
  app.get('/api/export', async (req) => {
    const withState = (req.query as Record<string, string>).state === '1';
    const collections = repos.listCollections();
    const keyOf = new Map(collections.map((c) => [c.id, c.name]));
    const bundle: ExportBundle = {
      version: 1,
      backends: repos.listBackends().map(({ id, ...b }) => b),
      collections: collections.map(({ id, ...c }) => ({ ...c, key: c.name })),
      mocks: repos.listMocks().map(({ id, createdAt, updatedAt, collectionId, ...mk }) => ({
        ...mk,
        createdFromTrafficId: null,
        collection: collectionId != null ? (keyOf.get(collectionId) ?? null) : null,
      })),
      flowPages: repos.listFlowPages().map(({ id, ...p }) => p),
      ...(withState ? { state: state.all() } : {}),
    };
    return bundle;
  });
  app.post('/api/import', async (req) => {
    const q = req.query as Record<string, string>;
    const replace = q.mode === 'replace';
    const b = body(ExportBundleSchema, req.body);
    const result = tx(repos.db, () => {
      if (replace) {
        for (const x of repos.listMocks()) repos.deleteMock(x.id);
        for (const x of repos.listCollections()) repos.deleteCollection(x.id);
        for (const x of repos.listBackends()) repos.deleteBackend(x.id);
        for (const x of repos.listFlowPages()) repos.deleteFlowPage(x.id);
      }
      const colIds = new Map<string, number>();
      for (const c of b.collections) {
        const { key, ...rest } = c;
        const existing = repos.listCollections().find((x) => x.name === rest.name);
        colIds.set(key, existing ? existing.id : repos.createCollection(rest).id);
      }
      for (const be of b.backends) repos.createBackend(be);
      for (const p of b.flowPages) {
        const existing = repos.getFlowPageBySlug(p.slug);
        if (existing) repos.updateFlowPage(existing.id, p);
        else repos.createFlowPage(p);
      }
      for (const { collection, ...mk } of b.mocks) {
        repos.createMock({ ...mk, collectionId: collection ? (colIds.get(collection) ?? null) : null });
      }
      if (b.state) state.replaceAll(b.state as Record<string, unknown>);
      return { backends: b.backends.length, collections: b.collections.length, mocks: b.mocks.length, flowPages: b.flowPages.length };
    });
    changed('import');
    return result;
  });
}
