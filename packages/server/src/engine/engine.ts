import type { Mock, TrafficEntry } from '@mokie/shared';
import { randomUUID } from 'node:crypto';
import type { Repos } from '../db/repos.ts';
import type { StateStore } from '../state/store.ts';
import type { Bus } from '../traffic/bus.ts';
import { FLOW_PREFIX, FlowService } from '../flows/service.ts';
import { applyEffects } from './effects.ts';
import { evaluateMock, findMock, type MockEvaluation } from './matcher.ts';
import { forward, selectBackend } from './proxy.ts';
import { flattenHeaders, isTextual, toMokieRequest } from './request.ts';
import { runScript } from './sandbox.ts';
import { render, type TemplateContext } from './template.ts';
import type { IncomingReq, MokieRequest, OutgoingRes } from './types.ts';

const PASS = Symbol('pass');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  readonly flows: FlowService;

  constructor(
    private repos: Repos,
    private state: StateStore,
    private bus: Bus,
  ) {
    this.flows = new FlowService(repos, state);
  }

  /** Build the template / script context for a request. */
  makeContext(req: MokieRequest, dryRun = false): TemplateContext {
    const ids = new Map<string, string>();
    const ctx: TemplateContext = {
      req,
      params: req.params,
      query: req.query,
      headers: req.headers,
      cookies: req.cookies,
      body: req.body,
      state: this.state.all(),
      vars: {},
    };
    Object.defineProperty(ctx, '__runtime', {
      enumerable: false,
      value: {
        flowUrl: (slug: string, c: Record<string, unknown>) =>
          dryRun ? `${req.baseUrl}/__mokie/p/<dry-run:${slug}>` : this.flows.createSession(slug, c, req.baseUrl).url,
        // stable per-request ids: {{id 'order'}} returns the same uuid in effects and response
        id: (name: string) => ids.get(name) ?? (ids.set(name, randomUUID()), ids.get(name)!),
      },
    });
    return ctx;
  }

  /** Entry point for every request hitting the proxy port. */
  async handle(inReq: IncomingReq): Promise<OutgoingRes> {
    const started = performance.now();
    const settings = this.repos.getSettings();
    const req = toMokieRequest(inReq, settings.publicUrl);
    let res: OutgoingRes;
    try {
      if (req.path.startsWith('/__mokie/')) res = await this.handleInternal(req);
      else res = await this.dispatch(inReq, req);
    } catch (e) {
      res = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ mokieError: (e as Error).message })),
        source: 'error',
        note: (e as Error).message,
      };
    }
    this.record(req, res, performance.now() - started, settings.trafficRetention, settings.maxBodyBytes);
    return res;
  }

  private async dispatch(inReq: IncomingReq, req: MokieRequest): Promise<OutgoingRes> {
    const ev = findMock(this.repos.activeMocks(), req, this.state.all(), (r) => this.makeContext(r));
    if (ev) {
      const out = await this.respondWithMock(ev, inReq, { ...req, params: ev.params });
      if (out !== PASS) return out;
    }
    return this.passthrough(inReq, req);
  }

  async passthrough(inReq: IncomingReq, req: MokieRequest, note = ''): Promise<OutgoingRes> {
    const backend = selectBackend(this.repos.listBackends(), req);
    if (!backend) {
      const s = this.repos.getSettings();
      const status = s.noBackendFallback === 'badGateway' ? 502 : 404;
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ mokie: 'nessun mock attivo e nessun backend configurato per questo path', path: req.path })),
        source: 'fallback',
        note: note || 'no mock, no backend',
      };
    }
    try {
      const r = await forward(backend, inReq, req);
      return {
        status: r.status,
        statusMessage: r.statusMessage,
        headers: r.headers,
        rawHeaders: r.rawHeaders,
        body: r.body,
        logBody: r.decoded,
        source: 'proxy',
        backendId: backend.id,
        note,
      };
    } catch (e) {
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ mokie: 'backend non raggiungibile', backend: backend.baseUrl, error: (e as Error).message })),
        source: 'error',
        backendId: backend.id,
        note: `backend error: ${(e as Error).message}`,
      };
    }
  }

  private async respondWithMock(ev: MockEvaluation, inReq: IncomingReq, req: MokieRequest): Promise<OutgoingRes | typeof PASS> {
    const mock = ev.mock;
    const ctx = this.makeContext(req);
    const base = { source: 'mock' as const, mockId: mock.id };

    let scripted: unknown;
    if (mock.script.trim()) {
      scripted = await runScript(mock.script, this.scriptScope(mock, inReq, req, ctx));
      if (scripted === PASS) return PASS;
    }

    applyEffects(mock.effects, this.state, ctx);
    ctx.state = this.state.all();

    let out: OutgoingRes;
    if (scripted !== undefined && scripted !== null && typeof scripted === 'object') {
      out = { ...this.fromScriptResult(scripted as Record<string, unknown>), ...base };
    } else {
      const spec = mock.response;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k.toLowerCase()] = render(v, ctx);
      out = { status: spec.status, headers, body: Buffer.from(render(spec.body ?? '', ctx)), ...base };
    }
    if (mock.response.delayMs) await sleep(mock.response.delayMs);
    out.note = mock.name;
    return out;
  }

  private fromScriptResult(r: Record<string, unknown>): Omit<OutgoingRes, 'source'> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.headers as Record<string, unknown>) ?? {})) {
      if (k.toLowerCase() === 'content-encoding' || k.toLowerCase() === 'content-length') continue;
      headers[k.toLowerCase()] = String(v);
    }
    let body: Buffer;
    if (r.body === undefined || r.body === null) body = Buffer.alloc(0);
    else if (typeof r.body === 'string') body = Buffer.from(r.body);
    else if (Buffer.isBuffer(r.body)) body = r.body;
    else {
      body = Buffer.from(JSON.stringify(r.body));
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    return { status: Number(r.status) || 200, headers, body };
  }

  /** API exposed to mock scripts. */
  private scriptScope(mock: Mock, inReq: IncomingReq, req: MokieRequest, ctx: TemplateContext) {
    const state = this.state;
    const logs: unknown[][] = [];
    return {
      req,
      params: req.params,
      query: req.query,
      headers: req.headers,
      body: req.body,
      cookies: req.cookies,
      vars: ctx.vars,
      state: {
        get: (p = '') => state.get(p),
        set: (p: string, v: unknown) => state.set(p, v),
        merge: (p: string, v: unknown) => state.merge(p, v),
        incr: (p: string, by = 1) => state.incr(p, by),
        push: (p: string, v: unknown) => state.push(p, v),
        remove: (p: string) => state.remove(p),
        all: () => state.all(),
      },
      flow: {
        url: (slug: string, c: Record<string, unknown> = {}) => this.flows.createSession(slug, c, req.baseUrl).url,
        create: (slug: string, c: Record<string, unknown> = {}) => this.flows.createSession(slug, c, req.baseUrl),
      },
      template: (t: string) => render(t, { ...ctx, state: state.all() }),
      respond: (status: number | Record<string, unknown>, body?: unknown, headers?: Record<string, string>) =>
        typeof status === 'object' ? status : { status, body, headers },
      /** Forward to the backend (optionally overriding method/path/headers/body) and get the decoded response. */
      forward: async (o: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
        const backend = selectBackend(this.repos.listBackends(), req);
        if (!backend) throw new Error('nessun backend configurato per questo path');
        const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
        const r = await forward(backend, inReq, req, { ...o, body });
        const text = r.decoded.toString('utf8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* text */
        }
        const { 'content-encoding': _ce, ...headers } = r.headers;
        return { status: r.status, headers, body: parsed };
      },
      /** Give up on this mock and let the request go to the backend. */
      pass: () => PASS,
      sleep,
      uuid: () => randomUUID(),
      log: (...a: unknown[]) => logs.push(a),
      console: { log: (...a: unknown[]) => console.log(`[mock ${mock.id}]`, ...a) },
    };
  }

  private async handleInternal(req: MokieRequest): Promise<OutgoingRes> {
    const toOut = (r: { status: number; headers: Record<string, string>; body: string; note: string }): OutgoingRes => ({
      status: r.status,
      headers: r.headers,
      body: Buffer.from(r.body),
      source: 'flow',
      note: r.note,
    });
    if (req.path.startsWith(FLOW_PREFIX)) {
      const rest = req.path.slice(FLOW_PREFIX.length).split('/').map(decodeURIComponent);
      const [token, kind, ctaId] = rest;
      if (rest.length === 1 && req.method === 'GET') return toOut(await this.flows.show(token, req.query));
      if (kind === 'cta' && ctaId && (req.method === 'POST' || req.method === 'GET')) return toOut(await this.flows.choose(token, ctaId));
    }
    if (req.path === '/__mokie/health') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}'), source: 'flow' };
    }
    return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('mokie: not found'), source: 'flow' };
  }

  /** Dry-run: explain how each mock evaluates against a sample request (no side effects). */
  explain(inReq: IncomingReq) {
    const req = toMokieRequest(inReq, this.repos.getSettings().publicUrl);
    const state = this.state.all();
    const noFlow = (r: MokieRequest) => this.makeContext(r, true);
    const active = new Set(this.repos.activeMocks().map((m) => m.id));
    const evaluations = this.repos.listMocks().map((m) => ({ active: active.has(m.id), ...evaluateMock(m, req, state, noFlow) }));
    const winner = evaluations.find((e) => e.active && e.matched);
    const backend = selectBackend(this.repos.listBackends(), req);
    return {
      request: { method: req.method, path: req.path, query: req.query, params: winner?.params ?? {} },
      winner: winner ? { id: winner.mock.id, name: winner.mock.name } : null,
      backend: backend ? { id: backend.id, name: backend.name, baseUrl: backend.baseUrl } : null,
      evaluations: evaluations.map((e) => ({
        mockId: e.mock.id,
        name: e.mock.name,
        active: e.active,
        methodOk: e.methodOk,
        pathOk: e.pathOk,
        matched: e.matched,
        params: e.params,
        conditions: e.conditions,
      })),
    };
  }

  private record(req: MokieRequest, res: OutgoingRes, ms: number, retention: number, maxBody: number) {
    const resHeaders = flattenHeaders(res.headers);
    const entry: Omit<TrafficEntry, 'id'> = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      path: req.path,
      reqHeaders: req.headers,
      reqBody: bodyForLog(req.rawBody ? Buffer.from(req.rawBody) : Buffer.alloc(0), req.headers['content-type'], maxBody),
      status: res.status,
      resHeaders,
      resBody: bodyForLog(res.logBody ?? res.body, resHeaders['content-type'], maxBody),
      durationMs: Math.round(ms),
      source: res.source,
      mockId: res.mockId ?? null,
      backendId: res.backendId ?? null,
      note: res.note ?? '',
    };
    try {
      const saved = this.repos.insertTraffic(entry, retention);
      const { reqHeaders, reqBody, resHeaders: _rh, resBody, ...summary } = saved;
      this.bus.emit('traffic', summary);
    } catch (e) {
      console.error('mokie: failed to record traffic', e);
    }
  }
}

function bodyForLog(buf: Buffer, contentType: string | undefined, max: number): string {
  if (!buf.length) return '';
  if (!isTextual(contentType)) return `[binary ${buf.length} bytes${contentType ? `, ${contentType}` : ''}]`;
  const s = buf.subarray(0, max).toString('utf8');
  return buf.length > max ? `${s}\n…[troncato, ${buf.length} bytes totali]` : s;
}
