import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { openDb } from './db/index.ts';
import { Repos } from './db/repos.ts';
import { StateStore } from './state/store.ts';
import { Bus } from './traffic/bus.ts';
import { Engine } from './engine/engine.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { ADMIN_PREFIX, type MokieConfig } from './config.ts';

export type Mokie = {
  config: MokieConfig;
  repos: Repos;
  state: StateStore;
  bus: Bus;
  engine: Engine;
  /** single HTTP server: proxy/mock on every path, admin UI + API under /_admin/ */
  app: FastifyInstance;
  close: () => Promise<void>;
};

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export async function createMokie(config: MokieConfig): Promise<Mokie> {
  const db = openDb(config.dbPath);
  const repos = new Repos(db);
  if (config.publicUrl && !repos.getSettings().publicUrl) repos.updateSettings({ publicUrl: config.publicUrl });
  const state = new StateStore(db);
  const bus = new Bus();
  state.onChange((keys) => bus.emit('state', keys));
  const engine = new Engine(repos, state, bus);

  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024, exposeHeadRoutes: false, routerOptions: { maxParamLength: 2048 } });
  const mokie: Mokie = {
    config,
    repos,
    state,
    bus,
    engine,
    app,
    close: async () => {
      await app.close();
      db.close();
    },
  };

  // ---------- admin: UI + API under /_admin/ (own encapsulated context, JSON body parser) ----------
  await app.register(
    async (admin) => {
      registerAdminRoutes(admin, mokie);
      if (existsSync(config.uiDir)) {
        // wildcard (default): files are resolved at request time, so a rebuild of the UI is picked up without a restart
        await admin.register(fastifyStatic, { root: config.uiDir, index: 'index.html', cacheControl: false });
        admin.setNotFoundHandler((req, reply) => {
          if (req.url.startsWith(`${ADMIN_PREFIX}/api/`)) return reply.code(404).send({ error: 'not found' });
          // a missing asset must be a 404, never index.html (which the browser would reject as a module)
          if (/\.[a-z0-9]+(\?.*)?$/i.test(req.url)) return reply.code(404).type('text/plain').send('not found');
          return reply.sendFile('index.html');
        });
      } else {
        admin.route({
          method: 'GET',
          url: '/',
          prefixTrailingSlash: 'slash',
          handler: async (_req, reply) =>
          reply
            .type('text/html; charset=utf-8')
            .send(
              '<!doctype html><meta charset="utf-8"><title>Mokie</title><body style="font:16px system-ui;padding:40px">' +
                '<h2>Mokie: UI non compilata</h2><p>Esegui <code>npm run build</code> e riavvia, oppure in sviluppo apri ' +
                '<a href="http://localhost:5173/_admin/">http://localhost:5173/_admin/</a> (avviato da <code>npm run dev</code>).</p>',
            ),
        });
      }
      // nothing under /_admin/ may fall through to the proxy
      admin.route({
        method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        url: '/*',
        handler: async (_req, reply) => reply.code(404).send({ error: 'not found' }),
      });
    },
    { prefix: ADMIN_PREFIX },
  );
  // `/_admin` → `/_admin/` so relative asset URLs resolve (unless a plugin already answers it)
  if (!app.hasRoute({ method: 'GET', url: ADMIN_PREFIX })) {
    app.get(ADMIN_PREFIX, async (_req, reply) => reply.redirect(`${ADMIN_PREFIX}/`));
  }

  // ---------- proxy / mock engine: every other path (own context, raw body) ----------
  await app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    proxy.route({
      method: ALL_METHODS,
      url: '/*',
      handler: async (req, reply) => {
        const out = await engine.handle({
          method: req.method,
          url: req.raw.url ?? req.url,
          headers: req.headers,
          rawHeaders: req.raw.rawHeaders,
          rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          remoteAddress: req.ip,
          protocol: req.protocol as 'http' | 'https',
        });
        if (out.rawHeaders) {
          // passthrough: write the backend's status line and headers exactly as received (Fastify would lower-case them)
          reply.hijack();
          const res = reply.raw;
          res.sendDate = false;
          res.writeHead(out.status, out.statusMessage || undefined, out.rawHeaders);
          res.end(req.method === 'HEAD' ? undefined : out.body);
          return reply;
        }
        reply.code(out.status);
        for (const [k, v] of Object.entries(out.headers)) reply.header(k, v);
        return reply.send(out.body);
      },
    });
  });

  return mokie;
}
