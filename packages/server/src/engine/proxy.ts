import type { Backend } from '@mokie/shared';
import { request } from 'undici';
import zlib from 'node:zlib';
import type { IncomingReq, MokieRequest } from './types.ts';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
]);

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

export function buildTargetUrl(backend: Backend, req: MokieRequest): string {
  const u = new URL(req.url, 'http://x');
  let path = u.pathname;
  if (backend.matchType === 'prefix' && backend.stripPrefix) {
    const p = normPrefix(backend.matchValue);
    if (p !== '/') path = path.slice(p.length) || '/';
  }
  const base = backend.baseUrl.replace(/\/+$/, '');
  return base + path + u.search;
}

export type ProxiedResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** body with content-encoding removed */
  decoded: Buffer;
};

export async function forward(
  backend: Backend,
  inReq: IncomingReq,
  req: MokieRequest,
  overrides?: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<ProxiedResponse> {
  const target = new URL(overrides?.path ? backend.baseUrl.replace(/\/+$/, '') + overrides.path : buildTargetUrl(backend, req));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers['host'] = target.host;
  headers['x-forwarded-host'] = req.headers['host'] ?? '';
  headers['x-forwarded-proto'] = req.baseUrl.startsWith('https') ? 'https' : 'http';
  if (inReq.remoteAddress) headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], inReq.remoteAddress].filter(Boolean).join(', ');
  Object.assign(headers, backend.headersOverride, overrides?.headers ?? {});

  const method = (overrides?.method ?? req.method).toUpperCase();
  const body = overrides?.body ?? inReq.rawBody;
  const res = await request(target, {
    method: method as any,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body.length ? body : undefined,
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  });
  const buf = Buffer.from(await res.body.arrayBuffer());
  const outHeaders: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    outHeaders[k] = v;
  }
  return { status: res.statusCode, headers: outHeaders, body: buf, decoded: decode(buf, outHeaders['content-encoding']) };
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
