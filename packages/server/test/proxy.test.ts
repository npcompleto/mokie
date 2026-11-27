/**
 * Passthrough fidelity: what the client sends must reach the backend byte-for-byte, and what the backend answers must
 * reach the client byte-for-byte — header names keep their case, order and duplicates; path and query string are not
 * normalized or re-encoded; bodies are not decoded, re-encoded or reformatted.
 *
 * Both ends talk raw TCP, so nothing in between (Node's http parser, fetch, light-my-request) can hide a change.
 *
 * The only changes a proxy is allowed to make:
 *  - `Host` is set to the backend's host (needed for virtual hosts / TLS), keeping the header name as the client wrote it;
 *  - `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` are added;
 *  - hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, …) are per connection, not end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendInputSchema } from '@mokie/shared';
import { createMokie, type Mokie } from '../src/app.ts';

// ---------------------------------------------------------------- raw HTTP/1.1 helpers

type RawMessage = {
  /** request line or status line, exactly as sent */
  startLine: string;
  /** header lines in order, exactly as sent: [name, value] */
  headers: [string, string][];
  body: Buffer;
};

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection']);
const FORWARDED = new Set(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);

/** Parse one complete HTTP/1.1 message from `buf`, or return null if it is not complete yet. */
function parseMessage(buf: Buffer, opts: { noBody?: boolean } = {}): (RawMessage & { size: number }) | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const [startLine, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
  const headers = lines.map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string];
  });
  const get = (n: string) => headers.find(([k]) => k.toLowerCase() === n)?.[1];
  let pos = end + 4;
  if (opts.noBody) return { startLine, headers, body: Buffer.alloc(0), size: pos };
  if (/chunked/i.test(get('transfer-encoding') ?? '')) {
    const chunks: Buffer[] = [];
    for (;;) {
      const nl = buf.indexOf('\r\n', pos);
      if (nl < 0) return null;
      const n = parseInt(buf.subarray(pos, nl).toString('latin1'), 16);
      if (buf.length < nl + 2 + n + 2) return null;
      if (n === 0) return { startLine, headers, body: Buffer.concat(chunks), size: nl + 4 };
      chunks.push(buf.subarray(nl + 2, nl + 2 + n));
      pos = nl + 2 + n + 2;
    }
  }
  const len = Number(get('content-length') ?? 0);
  if (buf.length < pos + len) return null;
  return { startLine, headers, body: Buffer.from(buf.subarray(pos, pos + len)), size: pos + len };
}

/** Send raw bytes to host:port, resolve with the raw response. */
function rawRequest(port: number, bytes: Buffer, opts: { head?: boolean } = {}): Promise<RawMessage> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => (sock.destroy(), reject(new Error('timeout; got: ' + buf.toString('latin1')))), 5000);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const status = buf.subarray(9, 12).toString();
      const msg = parseMessage(buf, { noBody: opts.head || status === '204' || status === '304' });
      if (msg) {
        clearTimeout(timer);
        sock.destroy();
        resolve(msg);
      }
    });
    sock.on('error', reject);
    sock.write(bytes);
  });
}

/** Build a raw request; `headers` are written exactly as given (case, order, duplicates). */
function buildRequest(method: string, target: string, headers: [string, string][], body?: Buffer): Buffer {
  const all: [string, string][] = [['Host', 'client.example:8080'], ...headers];
  if (body && !all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k))) all.push(['Content-Length', String(body.length)]);
  all.push(['Connection', 'close']);
  const head = `${method} ${target} HTTP/1.1\r\n` + all.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';
  return Buffer.concat([Buffer.from(head, 'latin1'), body ?? Buffer.alloc(0)]);
}

const endToEnd = (h: [string, string][]) => h.filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()));

// ---------------------------------------------------------------- raw backend

type BackendReply = { startLine?: string; headers: [string, string][]; body?: Buffer; chunked?: boolean };

let backend: net.Server;
let backendPort: number;
/** requests the backend received, raw */
let received: RawMessage[] = [];
/** what the backend answers next */
let reply: BackendReply;

function writeReply(sock: net.Socket, r: BackendReply, isHead: boolean) {
  const body = r.body ?? Buffer.alloc(0);
  const headers = [...r.headers];
  if (r.chunked) headers.push(['Transfer-Encoding', 'chunked']);
  else if (!headers.some(([k]) => k.toLowerCase() === 'content-length')) headers.push(['Content-Length', String(body.length)]);
  headers.push(['Connection', 'close']);
  const head = (r.startLine ?? 'HTTP/1.1 200 OK') + '\r\n' + headers.map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';
  sock.write(Buffer.from(head, 'latin1'));
  if (!isHead) {
    if (r.chunked) {
      const half = Math.ceil(body.length / 2);
      for (const part of [body.subarray(0, half), body.subarray(half)])
        if (part.length) sock.write(Buffer.concat([Buffer.from(part.length.toString(16) + '\r\n'), part, Buffer.from('\r\n')]));
      sock.write('0\r\n\r\n');
    } else sock.write(body);
  }
  sock.end();
}

// ---------------------------------------------------------------- mokie

let m: Mokie;
let port: number;
let dir: string;

beforeAll(async () => {
  backend = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const msg = parseMessage(buf);
      if (!msg) return;
      received.push(msg);
      writeReply(sock, reply, msg.startLine.startsWith('HEAD '));
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  backendPort = (backend.address() as net.AddressInfo).port;

  dir = mkdtempSync(join(tmpdir(), 'mokie-proxy-'));
  m = await createMokie({ port: 0, host: '127.0.0.1', dbPath: join(dir, 'p.db'), uiDir: '/nonexistent', publicUrl: '' });
  m.repos.createBackend(BackendInputSchema.parse({ name: 'raw', baseUrl: `http://127.0.0.1:${backendPort}`, matchValue: '/' }));
  await m.app.listen({ port: 0, host: '127.0.0.1' });
  port = (m.app.server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await m.close();
  await new Promise((r) => backend.close(r));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  reply = { headers: [['Content-Type', 'text/plain']], body: Buffer.from('ok') };
});

/** Send through mokie and return [what the backend got, what the client got]. */
async function roundTrip(method: string, target: string, headers: [string, string][], body?: Buffer) {
  const res = await rawRequest(port, buildRequest(method, target, headers, body), { head: method === 'HEAD' });
  expect(received).toHaveLength(1);
  return [received[0], res] as const;
}

// ---------------------------------------------------------------- request → backend

describe('proxy: request is forwarded unchanged', () => {
  it('keeps header names case, values, order and duplicates', async () => {
    const headers: [string, string][] = [
      ['X-Request-ID', 'AbC-123'],
      ['x-lower-case', 'v'],
      ['X-UPPER-CASE', 'V'],
      ['x-MiXeD-CaSe', 'MiXeD Value'],
      ['Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.ZRrHA1JJJW8opsbCGfG_HACGpVUMN_a9IV7pAx_Zmeo'],
      ['Accept', 'application/json, text/plain;q=0.9, */*;q=0.1'],
      ['X-Dup', 'first'],
      ['Cookie', 'Session=XyZ; theme=Dark'],
      ['X-Dup', 'second'],
      ['X-Spaces', 'a  b   c'],
      ['X-Empty', ''],
      ['X-Json', '{"A":1,"b":[true,null]}'],
      ['Accept-Encoding', 'gzip, deflate, br'],
    ];
    const [got] = await roundTrip('GET', '/headers', headers);

    // original headers, in order, untouched — apart from Host, which points to the backend
    const sent = endToEnd(got.headers).filter(([k]) => !FORWARDED.has(k.toLowerCase()));
    expect(sent).toEqual([['Host', `127.0.0.1:${backendPort}`], ...headers]);
  });

  it('only adds the X-Forwarded-* headers', async () => {
    const [got] = await roundTrip('GET', '/fwd', [['X-A', '1']]);
    const added = endToEnd(got.headers).filter(([k]) => FORWARDED.has(k.toLowerCase()));
    expect(Object.fromEntries(added.map(([k, v]) => [k.toLowerCase(), v]))).toEqual({
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-host': 'client.example:8080',
      'x-forwarded-proto': 'http',
    });
  });

  it('keeps the X-Forwarded-For chain of an upstream proxy', async () => {
    const [got] = await roundTrip('GET', '/fwd', [['X-Forwarded-For', '203.0.113.7']]);
    expect(got.headers.filter(([k]) => k.toLowerCase() === 'x-forwarded-for')).toEqual([['X-Forwarded-For', '203.0.113.7, 127.0.0.1']]);
  });

  it.each([
    ['mixed case path and query', '/Api/V1/Users/AbC?SortBy=Name&sortby=name&Filter=Status:ACTIVE'],
    ['repeated and empty params', '/search?tag=A&tag=b&tag=A&empty=&flag&=novalue'],
    ['percent encoding kept as is (case too)', '/files/a%2Fb/%7euser?path=%2Fhome%2fUser&q=%E2%82%AC&sp=a%20b+c'],
    ['unencoded characters', "/x/it's/(1)/[2]/~me/@at/$d/!ok?a=1:2&b=[x]&c=a,b&d=it's"],
    ['dot segments are not resolved', '/a/./b/../c/.%2e/d'],
    ['double and trailing slashes', '//double//slashes/?x=1'],
    ['matrix params and fragment-like chars', '/path;jsessionid=AbC123;v=2?redirect=http%3A%2F%2Fexample.com%2F%3Fa%3D1%23frag'],
    ['plus vs %20', '/q?a+b=c+d&e%20f=g%20h'],
    ['no query, only ?', '/only?'],
    ['very long query', '/long?' + Array.from({ length: 200 }, (_, i) => `Key${i}=Value${i}`).join('&')],
  ])('keeps the request target byte-for-byte: %s', async (_name, target) => {
    const [got] = await roundTrip('GET', target, []);
    expect(got.startLine).toBe(`GET ${target} HTTP/1.1`);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('keeps method and body for %s', async (method) => {
    const body = Buffer.from('{ "Name" : "Mario",\n\t"Amount":10.50, "nested":{"Z":1,"a":2} }   ');
    const [got] = await roundTrip(method, '/m', [['Content-Type', 'application/json; charset=UTF-8']], body);
    expect(got.startLine).toBe(`${method} /m HTTP/1.1`);
    expect(got.body.equals(body)).toBe(true);
    expect(got.headers.find(([k]) => k === 'Content-Type')?.[1]).toBe('application/json; charset=UTF-8');
  });

  it('keeps binary bodies byte-for-byte', async () => {
    const body = randomBytes(256 * 1024);
    const [got] = await roundTrip('POST', '/bin', [['Content-Type', 'application/octet-stream']], body);
    expect(got.body.equals(body)).toBe(true);
    expect(got.headers.find(([k]) => k.toLowerCase() === 'content-length')?.[1]).toBe(String(body.length));
  });

  it('does not decode compressed request bodies', async () => {
    const body = zlib.gzipSync(Buffer.from('{"compressed":true}'));
    const headers: [string, string][] = [
      ['Content-Type', 'application/json'],
      ['Content-Encoding', 'gzip'],
    ];
    const [got] = await roundTrip('POST', '/gz', headers, body);
    expect(got.body.equals(body)).toBe(true);
    expect(got.headers).toContainEqual(['Content-Encoding', 'gzip']);
  });

  it('keeps form and multipart bodies (no re-encoding of the form)', async () => {
    const form = Buffer.from('B=2&a=1&a=1&Name=Mario+Rossi&e=%E2%82%AC&raw=%2B');
    const [g1] = await roundTrip('POST', '/form', [['Content-Type', 'application/x-www-form-urlencoded']], form);
    expect(g1.body.equals(form)).toBe(true);

    received = [];
    const boundary = '----MokieBoundaryXYZ';
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="Field"\r\n\r\nValue\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      randomBytes(1024),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const [g2] = await roundTrip('POST', '/upload', [['Content-Type', `multipart/form-data; boundary=${boundary}`]], multipart);
    expect(g2.body.equals(multipart)).toBe(true);
  });

  it('keeps bodies with unusual or missing content types', async () => {
    const body = Buffer.from('<Root Attr="1"><Child/></Root>');
    const [g1] = await roundTrip('POST', '/xml', [['Content-Type', 'Application/Vnd.Custom+XML; Version=2']], body);
    expect(g1.body.equals(body)).toBe(true);
    expect(g1.headers).toContainEqual(['Content-Type', 'Application/Vnd.Custom+XML; Version=2']);

    received = [];
    const [g2] = await roundTrip('POST', '/no-type', [], Buffer.from('plain bytes'));
    expect(g2.body.toString()).toBe('plain bytes');
  });

  it('forwards chunked request bodies with the same content', async () => {
    const chunked = Buffer.from('5\r\nHello\r\n7\r\n, World\r\n0\r\n\r\n');
    const [got] = await roundTrip('POST', '/chunked', [['Content-Type', 'text/plain'], ['Transfer-Encoding', 'chunked']], chunked);
    expect(got.body.toString()).toBe('Hello, World');
  });
});

// ---------------------------------------------------------------- backend → client

describe('proxy: response is returned unchanged', () => {
  it('keeps status, header names case, values, order and duplicates', async () => {
    const headers: [string, string][] = [
      ['Content-Type', 'application/json; charset=utf-8'],
      ['X-Request-ID', 'AbC-123'],
      ['x-lower-case', 'v'],
      ['X-UPPER-CASE', 'V'],
      ['x-MiXeD-CaSe', 'MiXeD Value'],
      ['Set-Cookie', 'Session=XyZ; Path=/; HttpOnly'],
      ['Set-Cookie', 'Theme=Dark; Max-Age=3600'],
      ['X-Dup', 'first'],
      ['X-Dup', 'second'],
      ['Cache-Control', 'no-cache, no-store'],
      ['ETag', 'W/"AbC"'],
      ['Date', 'Mon, 01 Jan 2024 00:00:00 GMT'],
      ['Server', 'RawBackend/1.0'],
      ['WWW-Authenticate', 'Bearer realm="Mokie"'],
    ];
    reply = { startLine: 'HTTP/1.1 201 Created', headers, body: Buffer.from('{"Id":"AbC","list":[1, 2,3]}') };
    const [, res] = await roundTrip('POST', '/resp', [], Buffer.from('{}'));

    expect(res.startLine).toBe('HTTP/1.1 201 Created');
    expect(endToEnd(res.headers)).toEqual([...headers, ['Content-Length', '28']]);
    expect(res.body.toString()).toBe('{"Id":"AbC","list":[1, 2,3]}');
  });

  it.each([
    ['HTTP/1.1 200 OK'],
    ['HTTP/1.1 202 Accepted'],
    ['HTTP/1.1 302 Found'],
    ['HTTP/1.1 400 Bad Request'],
    ['HTTP/1.1 401 Unauthorized'],
    ['HTTP/1.1 404 Not Found'],
    ['HTTP/1.1 418 I Am A Teapot'],
    ['HTTP/1.1 422 Custom Reason Phrase'],
    ['HTTP/1.1 500 Internal Server Error'],
    ['HTTP/1.1 503 Service Unavailable'],
    ['HTTP/1.1 599 Weird'],
  ])('keeps the status line: %s', async (startLine) => {
    reply = { startLine, headers: [['Location', '/Next?A=1']], body: Buffer.from('x') };
    const [, res] = await roundTrip('GET', '/status', []);
    expect(res.startLine).toBe(startLine);
    expect(res.headers).toContainEqual(['Location', '/Next?A=1']);
  });

  it('204 and 304 without body', async () => {
    reply = { startLine: 'HTTP/1.1 204 No Content', headers: [['X-Thing', 'A']] };
    const [, r1] = await roundTrip('DELETE', '/x', []);
    expect(r1.startLine).toBe('HTTP/1.1 204 No Content');
    expect(endToEnd(r1.headers)).toEqual([['X-Thing', 'A'], ['Content-Length', '0']]);

    received = [];
    reply = { startLine: 'HTTP/1.1 304 Not Modified', headers: [['ETag', '"V1"']] };
    const [, r2] = await roundTrip('GET', '/x', [['If-None-Match', '"V1"']]);
    expect(r2.startLine).toBe('HTTP/1.1 304 Not Modified');
    expect(r2.headers).toContainEqual(['ETag', '"V1"']);
  });

  it('does not decompress, re-encode or reformat the body', async () => {
    const json = '{ "Pretty" : true,\n  "Space":   1 }';
    for (const [enc, data] of [
      ['gzip', zlib.gzipSync(json)],
      ['br', zlib.brotliCompressSync(json)],
      ['deflate', zlib.deflateSync(json)],
    ] as const) {
      received = [];
      reply = { headers: [['Content-Type', 'application/json'], ['Content-Encoding', enc], ['Vary', 'Accept-Encoding']], body: data };
      const [, res] = await roundTrip('GET', `/z/${enc}`, [['Accept-Encoding', 'gzip, deflate, br']]);
      expect(res.body.equals(data)).toBe(true);
      expect(endToEnd(res.headers)).toEqual([...reply.headers, ['Content-Length', String(data.length)]]);
    }
    // ...but the traffic log stores the decoded body for reading
    const t = m.repos.getTraffic(m.repos.listTraffic({ limit: 1 })[0].id)!;
    expect(t.resBody).toBe(json);
  });

  it('keeps binary response bodies byte-for-byte', async () => {
    const body = randomBytes(300 * 1024);
    reply = { headers: [['Content-Type', 'image/png']], body };
    const [, res] = await roundTrip('GET', '/img.png', []);
    expect(res.body.equals(body)).toBe(true);
  });

  it('passes the body of a chunked backend response unchanged', async () => {
    reply = { headers: [['Content-Type', 'text/plain'], ['X-Stream', 'Yes']], body: Buffer.from('Hello chunked World'), chunked: true };
    const [, res] = await roundTrip('GET', '/chunked', []);
    expect(res.body.toString()).toBe('Hello chunked World');
    expect(endToEnd(res.headers).slice(0, 2)).toEqual(reply.headers);
  });

  it('HEAD keeps the backend headers, including Content-Length', async () => {
    reply = { headers: [['Content-Type', 'application/pdf'], ['Content-Length', '12345'], ['Accept-Ranges', 'bytes']] };
    const [got, res] = await roundTrip('HEAD', '/doc.pdf', []);
    expect(got.startLine).toBe('HEAD /doc.pdf HTTP/1.1');
    expect(endToEnd(res.headers)).toEqual(reply.headers);
  });

  it('does not add headers of its own (no Date, X-Powered-By, …)', async () => {
    reply = { headers: [['X-Only', '1']], body: Buffer.from('a') };
    const [, res] = await roundTrip('GET', '/bare', []);
    expect(endToEnd(res.headers)).toEqual([['X-Only', '1'], ['Content-Length', '1']]);
  });

  it('records the passthrough in the traffic log', async () => {
    await roundTrip('GET', '/Logged/Path?Q=1', [['X-Case', 'Kept']]);
    const t = m.repos.listTraffic({ limit: 1 })[0];
    expect(t).toMatchObject({ method: 'GET', path: '/Logged/Path', source: 'proxy', status: 200 });
  });
});
