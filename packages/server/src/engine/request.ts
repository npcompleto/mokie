import type { IncomingReq, MokieRequest } from './types.ts';

export function flattenHeaders(h: IncomingReq['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

export function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else out[k] = Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function isTextual(contentType: string | undefined): boolean {
  if (!contentType) return true;
  return /json|text|xml|javascript|x-www-form-urlencoded|html|csv|yaml|graphql/i.test(contentType);
}

export function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (contentType && /json/i.test(contentType)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType && /x-www-form-urlencoded/i.test(contentType)) return parseQuery(text);
  // be lenient: try JSON anyway
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      /* not json */
    }
  }
  return text;
}

export function toMokieRequest(req: IncomingReq, publicUrl: string): MokieRequest {
  const headers = flattenHeaders(req.headers);
  const u = new URL(req.url, 'http://x');
  const proto = (headers['x-forwarded-proto']?.split(',')[0].trim() as string) || req.protocol || 'http';
  const host = headers['x-forwarded-host'] || headers['host'] || 'localhost';
  return {
    method: req.method.toUpperCase(),
    url: req.url,
    path: u.pathname,
    query: parseQuery(u.search),
    headers,
    cookies: parseCookies(headers['cookie']),
    body: parseBody(req.rawBody, headers['content-type']),
    rawBody: isTextual(headers['content-type']) ? req.rawBody.toString('utf8') : '',
    params: {},
    baseUrl: (publicUrl || `${proto}://${host}`).replace(/\/+$/, ''),
  };
}
