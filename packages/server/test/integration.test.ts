import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMokie, type Mokie } from '../src/app.ts';

let backend: FastifyInstance;
let backendUrl: string;
let m: Mokie;
let dir: string;

const config = (dbPath: string) => ({ port: 8080, host: '127.0.0.1', dbPath, uiDir: '/nonexistent', publicUrl: '' });
const api = (method: string, url: string, payload?: unknown) =>
  m.app.inject({ method: method as any, url: `/_admin${url}`, payload: payload as any }).then((r) => {
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  });
const hit = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  m.app.inject({ method: method as any, url, payload: payload as any, headers: { host: 'mokie.test', ...headers } });

beforeAll(async () => {
  backend = Fastify();
  backend.all('/*', async (req) => ({ from: 'backend', method: req.method, url: req.url, body: req.body ?? null }));
  await backend.listen({ port: 0, host: '127.0.0.1' });
  const addr = backend.server.address() as { port: number };
  backendUrl = `http://127.0.0.1:${addr.port}`;

  dir = mkdtempSync(join(tmpdir(), 'mokie-test-'));
  m = await createMokie(config(join(dir, 'test.db')));
  await api('POST', '/api/backends', { name: 'fake', baseUrl: backendUrl, matchValue: '/' });
});

afterAll(async () => {
  await m.close();
  await backend.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('proxy & mocks', () => {
  it('passes through to the backend when no mock matches', async () => {
    const r = await hit('GET', '/users/1?x=1');
    expect(r.json()).toMatchObject({ from: 'backend', url: '/users/1?x=1' });
    const traffic = await api('GET', '/api/traffic');
    expect(traffic[0]).toMatchObject({ source: 'proxy', path: '/users/1', status: 200 });
  });

  it('serves a mock only when conditions match', async () => {
    await api('POST', '/api/mocks', {
      name: 'vip user',
      method: 'GET',
      pathPattern: '/users/:id',
      conditions: [{ source: 'header', key: 'x-scenario', operator: 'equals', value: 'vip' }],
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"{{params.id}}","vip":true}' },
    });
    expect((await hit('GET', '/users/5', undefined, { 'x-scenario': 'vip' })).json()).toEqual({ id: '5', vip: true });
    expect((await hit('GET', '/users/5')).json()).toMatchObject({ from: 'backend' });
  });

  it('shares persistent state between endpoints', async () => {
    await api('POST', '/api/mocks', {
      name: 'add to cart',
      method: 'POST',
      pathPattern: '/cart',
      effects: [{ op: 'push', path: 'cart.items', value: '{{json body}}' }],
      response: { status: 201, headers: { 'content-type': 'application/json' }, body: '{"count": {{length state.cart.items}} }' },
    });
    await api('POST', '/api/mocks', {
      name: 'get cart',
      method: 'GET',
      pathPattern: '/cart',
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{{json state.cart}}' },
    });
    expect((await hit('POST', '/cart', { sku: 'A' })).json()).toEqual({ count: 1 });
    expect((await hit('POST', '/cart', { sku: 'B' })).json()).toEqual({ count: 2 });
    expect((await hit('GET', '/cart')).json()).toEqual({ items: [{ sku: 'A' }, { sku: 'B' }] });
  });

  it('state conditions and stable ids', async () => {
    await api('POST', '/api/mocks', {
      name: 'create order',
      method: 'POST',
      pathPattern: '/orders',
      effects: [{ op: 'set', path: "orders.{{id 'o'}}", value: '{"status":"NEW"}' }],
      response: { status: 201, headers: { 'content-type': 'application/json' }, body: `{"id":"{{id 'o'}}"}` },
    });
    await api('POST', '/api/mocks', {
      name: 'get existing order',
      method: 'GET',
      pathPattern: '/orders/:id',
      conditions: [{ source: 'state', key: 'orders.{{params.id}}', operator: 'exists', value: '' }],
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{{json (get state (concat "orders." params.id))}}' },
    });
    const { id } = (await hit('POST', '/orders', {})).json();
    expect((await hit('GET', `/orders/${id}`)).json()).toEqual({ status: 'NEW' });
    expect((await hit('GET', '/orders/unknown')).json()).toMatchObject({ from: 'backend' });
  });

  it('scripts can forward and modify the backend response, or pass', async () => {
    await api('POST', '/api/mocks', {
      name: 'enrich',
      method: 'GET',
      pathPattern: '/enrich',
      script: `if (query.skip) return pass();\nconst r = await forward();\nr.body.enriched = state.incr('enrichCount');\nreturn r;`,
    });
    expect((await hit('GET', '/enrich')).json()).toMatchObject({ from: 'backend', enriched: 1 });
    const passed = await hit('GET', '/enrich?skip=1');
    expect(passed.json()).toMatchObject({ from: 'backend' });
    expect(passed.json().enriched).toBeUndefined();
  });

  it('serves admin and proxy on the same port without overlap', async () => {
    expect((await m.app.inject({ method: 'GET', url: '/_admin/api/health' })).json()).toEqual({ ok: true, port: 8080 });
    expect((await m.app.inject({ method: 'GET', url: '/_admin' })).headers.location).toBe('/_admin/');
    expect((await m.app.inject({ method: 'GET', url: '/_admin/' })).body).toContain('UI non compilata');
    // unknown admin paths never reach the backend
    expect((await m.app.inject({ method: 'POST', url: '/_admin/whatever', payload: {} })).statusCode).toBe(404);
    // /api/... belongs to the user's backend now
    expect((await hit('GET', '/api/health')).json()).toMatchObject({ from: 'backend', url: '/api/health' });
    // admin calls are not recorded as traffic
    const t = await api('GET', '/api/traffic');
    expect(t.some((x: { path: string }) => x.path.startsWith('/_admin'))).toBe(false);
  });

  it('explains matching without side effects', async () => {
    const r = await api('POST', '/api/mocks/explain', { method: 'GET', url: '/users/3', headers: { 'x-scenario': 'vip' } });
    expect(r.winner.name).toBe('vip user');
  });

  it('calls the endpoint for real from the admin API (state + traffic)', async () => {
    const before = ((await api('GET', '/api/state')).cart?.items ?? []).length;
    const r = await api('POST', '/api/mocks/call', {
      method: 'POST',
      url: '/cart',
      headers: { 'content-type': 'application/json' },
      body: '{"sku":"C"}',
    });
    expect(r).toMatchObject({ status: 201, source: 'mock', body: `{"count": ${before + 1} }` });
    expect((await api('GET', '/api/state')).cart.items).toHaveLength(before + 1);
    expect((await api('GET', '/api/traffic'))[0]).toMatchObject({ method: 'POST', path: '/cart', source: 'mock' });
    // non-mocked requests still reach the backend
    expect(await api('POST', '/api/mocks/call', { method: 'GET', url: '/nothing' })).toMatchObject({ status: 200, source: 'proxy' });
  });

  it('creates a mock draft from traffic', async () => {
    await hit('GET', '/products/123?lang=it');
    const t = (await api('GET', '/api/traffic?q=products'))[0];
    const draft = await api('POST', `/api/traffic/${t.id}/to-mock`);
    expect(draft.mock.pathPattern).toBe('/products/:productId');
    expect(JSON.parse(draft.mock.response.body)).toMatchObject({ from: 'backend' });
    expect(draft.suggestedConditions).toContainEqual({ source: 'query', key: 'lang', operator: 'equals', value: 'it' });
  });
});

describe('interactive payment flow', () => {
  it('returns a page url and redirects back with the chosen outcome', async () => {
    const bundle = JSON.parse(readFileSync(new URL('../../../examples/payment-flow.json', import.meta.url), 'utf8'));
    await api('POST', '/api/import', bundle);

    const r = await hit('POST', '/payments', { redirect_url: 'http://shop.test/done?ref=x', orderId: '1', amount: 25 });
    expect(r.statusCode).toBe(201);
    const { paymentUrl } = r.json();
    expect(paymentUrl).toMatch(/^http:\/\/mokie\.test\/__mokie\/p\/[\w-]+$/);
    const path = new URL(paymentUrl).pathname;

    const page = await hit('GET', path);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Fondi insufficienti');

    const click = await hit('POST', `${path}/cta/ko-funds`);
    expect(click.statusCode).toBe(303);
    const loc = new URL(click.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('http://shop.test/done');
    expect(Object.fromEntries(loc.searchParams)).toEqual({ ref: 'x', status: 'KO', code: 'INSUFFICIENT_FUNDS', orderId: '1' });

    expect((await hit('GET', '/payments/1')).json()).toMatchObject({ orderId: '1', status: 'FAILED', reason: 'INSUFFICIENT_FUNDS' });
    // a session can be used only once
    expect((await hit('POST', `${path}/cta/ok`)).statusCode).toBe(409);
  });

  it('flow URLs created via "Chiama" use the host the admin was reached on', async () => {
    const r = await api('POST', '/api/mocks/call', {
      method: 'POST',
      url: '/payments',
      headers: { 'content-type': 'application/json' },
      body: '{"redirect_url":"http://shop.test/done","orderId":"9"}',
    });
    expect(JSON.parse(r.body).paymentUrl).toMatch(/^http:\/\/localhost:80\/__mokie\/p\//);
  });

  it('supports ?choose= for automated tests', async () => {
    const { paymentUrl } = (await hit('POST', '/payments', { redirect_url: 'http://shop.test/done', orderId: '2', amount: 1 })).json();
    const r = await hit('GET', new URL(paymentUrl).pathname + '?choose=ok');
    expect(r.headers.location).toBe('http://shop.test/done?status=OK&orderId=2');
    expect((await hit('GET', '/payments/2')).json()).toMatchObject({ status: 'PAID' });
  });
});

describe('persistence', () => {
  it('keeps mocks and state across restarts', async () => {
    const before = await api('GET', '/api/state');
    const mocks = (await api('GET', '/api/mocks')).length;
    await m.close();
    m = await createMokie(config(join(dir, 'test.db')));
    expect(await api('GET', '/api/state')).toEqual(before);
    expect((await api('GET', '/api/mocks')).length).toBe(mocks);
  });
});
