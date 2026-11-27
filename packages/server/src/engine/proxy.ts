import type { Backend } from '@mokie/shared';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { IncomingReq, MokieRequest } from './types.ts';


/** Pick the backend for a request: host matches first, then the longest matching prefix. */
export function selectBackend(backends: Backend[], req: MokieRequest): Backend | undefined {
  const enabled = backends.filter((b) => b.enabled);
  const host = (req.headers['host'] ?? '').toLowerCase();
  const byHost = enabled.filter(
    (b) => b.matchType === 'host' && (host === b.matchValue.toLowerCase() || host.split(':')[0] === b.matchValue.toLowerCase()),
  );
  if (byHost.length) return byHost.sort((a, b) => b.priority - a.priority)[0];
  return enabled
    .filter((b) => b.matchType === 'prefix' && prefixMatches(b.matchValue, req.path))
    .sort((a, b) => b.priority - a.priority || normPrefix(b.matchValue).length - normPrefix(a.matchValue).length)[0];
}

const normPrefix = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
function prefixMatches(prefix: string, path: string) {
  const p = normPrefix(prefix);
  return p === '/' || path === p || path.startsWith(p + '/');
}

/** Split a raw request target into path and query string ("?..." included), without any normalization. */
export function splitTarget(url: string): { path: string; search: string } {
  const i = url.indexOf('?');
  return i < 0 ? { path: url, search: '' } : { path: url.slice(0, i), search: url.slice(i) };
}

/**
 * Backend URL for a request. The request target is used exactly as received: no dot-segment resolution, no slash
 * merging, no re-encoding (`new URL()` would do all of that).
 */
export function buildTargetUrl(backend: Backend, req: Pick<MokieRequest, 'url'>): string {
  let { path, search } = splitTarget(req.url);
  if (backend.matchType === 'prefix' && backend.stripPrefix) {
    const p = normPrefix(backend.matchValue);
    if (p !== '/' && (path === p || path.startsWith(p + '/'))) path = path.slice(p.length) || '/';
  }
  return backend.baseUrl.replace(/\/+$/, '') + path + search;
}

export type ProxiedResponse = {
  status: number;
  statusMessage: string;
  /** lower-cased, for logs / scripts (no content-length) */
  headers: Record<string, string | string[]>;
  /** end-to-end headers exactly as the backend sent them: [name, value, name, value, ...] */
  rawHeaders: string[];
  body: Buffer;
  /** body with content-encoding removed */
  decoded: Buffer;
};

/** Raw header list helpers: names keep their case and order, duplicates stay separate. */
const isHopByHop = (name: string, extra: Set<string>) => HOP_BY_HOP_RAW.has(name.toLowerCase()) || extra.has(name.toLowerCase());
const HOP_BY_HOP_RAW = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** Headers named in `Connection: a, b` are hop-by-hop too (RFC 9110 §7.6.1). */
function connectionTokens(raw: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < raw.length; i += 2)
    if (raw[i].toLowerCase() === 'connection') for (const t of raw[i + 1].split(',')) if (t.trim()) out.add(t.trim().toLowerCase());
  return out;
}

function endToEnd(raw: string[]): string[] {
  const extra = connectionTokens(raw);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (!isHopByHop(raw[i], extra)) out.push(raw[i], raw[i + 1]);
  return out;
}

/** Set a header in a raw list: the first occurrence keeps its position and name case, the others are dropped. */
function setRaw(raw: string[], name: string, value: string): string[] {
  const n = name.toLowerCase();
  const out: string[] = [];
  let done = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== n) out.push(raw[i], raw[i + 1]);
    else if (!done) (out.push(raw[i], value), (done = true));
  }
  if (!done) out.push(name, value);
  return out;
}

const getRaw = (raw: string[], name: string) => {
  const vals: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name) vals.push(raw[i + 1]);
  return vals.length ? vals.join(', ') : undefined;
};

/** Raw request headers: as received when available, otherwise rebuilt from the parsed object (e.g. admin "Chiama"). */
function requestRawHeaders(inReq: IncomingReq): string[] {
  if (inReq.rawHeaders?.length) return [...inReq.rawHeaders];
  const out: string[] = [];
  for (const [k, v] of Object.entries(inReq.headers)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.push(k, x);
  }
  return out;
}

const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

/**
 * Forward a request to the backend, changing nothing but `Host` (pointed at the backend) and the `X-Forwarded-*`
 * headers. Method, request target, header names/order/duplicates and body bytes go out as received; the response
 * comes back raw (status line, headers, undecoded body).
 */
export async function forward(
  backend: Backend,
  inReq: IncomingReq,
  req: MokieRequest,
  overrides?: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<ProxiedResponse> {
  const target = new URL(backend.baseUrl);
  const full = overrides?.path ? backend.baseUrl.replace(/\/+$/, '') + overrides.path : buildTargetUrl(backend, req);
  // path as a raw string: everything after scheme://authority
  const pathOnBackend = full.slice(full.indexOf('/', full.indexOf('//') + 2)) || '/';

  let raw = endToEnd(requestRawHeaders(inReq));
  raw = setRaw(raw, 'Host', target.host);
  const clientHost = req.headers['host'] ?? '';
  const prevFor = getRaw(raw, 'x-forwarded-for');
  if (inReq.remoteAddress) raw = setRaw(raw, 'X-Forwarded-For', [prevFor, inReq.remoteAddress].filter(Boolean).join(', '));
  if (!getRaw(raw, 'x-forwarded-host')) raw = setRaw(raw, 'X-Forwarded-Host', clientHost);
  if (!getRaw(raw, 'x-forwarded-proto')) raw = setRaw(raw, 'X-Forwarded-Proto', req.baseUrl.startsWith('https') ? 'https' : 'http');
  for (const [k, v] of Object.entries({ ...backend.headersOverride, ...(overrides?.headers ?? {}) })) raw = setRaw(raw, k, v);

  const method = (overrides?.method ?? inReq.method).toUpperCase();
  let body = inReq.rawBody;
  if (overrides?.body !== undefined) {
    body = Buffer.isBuffer(overrides.body) ? overrides.body : Buffer.from(overrides.body);
    raw = setRaw(raw, 'Content-Length', String(body.length));
  } else if (getRaw(raw, 'content-length') === undefined && body.length) {
    // the client sent it chunked: the body is fully buffered here, so send its length
    raw = setRaw(raw, 'Content-Length', String(body.length));
  }

  const isHttps = target.protocol === 'https:';
  return new Promise<ProxiedResponse>((resolve, reject) => {
    const r = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || (isHttps ? 443 : 80),
        method,
        path: pathOnBackend,
        headers: raw,
        setHost: false,
        agent: isHttps ? agents.https : agents.http,
        insecureHTTPParser: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const rawOut = endToEnd(res.rawHeaders);
          const headers: Record<string, string | string[]> = {};
          for (let i = 0; i < rawOut.length; i += 2) {
            const k = rawOut[i].toLowerCase();
            if (k === 'content-length') continue;
            const cur = headers[k];
            headers[k] = cur === undefined ? rawOut[i + 1] : Array.isArray(cur) ? [...cur, rawOut[i + 1]] : [cur, rawOut[i + 1]];
          }
          resolve({
            status: res.statusCode ?? 502,
            statusMessage: res.statusMessage ?? '',
            headers,
            rawHeaders: rawOut,
            body: buf,
            decoded: decode(buf, headers['content-encoding']),
          });
        });
      },
    );
    r.setTimeout(60_000, () => r.destroy(new Error('backend timeout')));
    r.on('error', reject);
    r.end(body.length ? body : undefined);
  });
}

function decode(buf: Buffer, enc: string | string[] | undefined): Buffer {
  const e = (Array.isArray(enc) ? enc[0] : enc ?? '').toLowerCase().trim();
  try {
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
    if (e === 'br') return zlib.brotliDecompressSync(buf);
    if (e === 'deflate') return zlib.inflateSync(buf);
    if (e === 'zstd' && 'zstdDecompressSync' in zlib) return (zlib as any).zstdDecompressSync(buf);
  } catch {
    /* fall through */
  }
  return buf;
}
