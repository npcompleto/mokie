import type { Condition, MockInput, TrafficEntry } from '@mokie/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^\d+$/;
const HEX = /^[0-9a-f]{16,}$/i;
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;

/** `/orders/123/items/9f1c…` → `/orders/:id/items/:itemsId` */
export function inferPathPattern(path: string): { pattern: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const segs = path.split('/');
  const out = segs.map((seg, i) => {
    if (!seg || !(NUM.test(seg) || UUID.test(seg) || HEX.test(seg) || OPAQUE.test(seg))) return seg;
    const prev = segs[i - 1]?.replace(/[^A-Za-z0-9]/g, '') ?? '';
    let name = prev ? singular(prev) + 'Id' : 'id';
    if (Object.keys(params).length === 0 && !prev) name = 'id';
    while (name in params) name += '_';
    params[name] = seg;
    return `:${name}`;
  });
  return { pattern: out.join('/') || '/', params };
}

const singular = (s: string) => (s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s);

const KEEP_RES_HEADERS = ['content-type', 'cache-control', 'location', 'set-cookie', 'www-authenticate'];
const INTERESTING_REQ_HEADERS = ['authorization', 'x-api-key', 'x-tenant-id', 'accept-language', 'x-scenario', 'content-type'];

export type MockDraft = { mock: MockInput; suggestedConditions: Condition[] };

export function trafficToMock(t: TrafficEntry): MockDraft {
  const { pattern, params } = inferPathPattern(t.path);
  const headers: Record<string, string> = {};
  for (const k of KEEP_RES_HEADERS) if (t.resHeaders[k]) headers[k] = t.resHeaders[k];

  let body = t.resBody;
  if (/json/i.test(headers['content-type'] ?? '')) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* keep raw */
    }
  }

  const suggested: Condition[] = [];
  for (const [k, v] of Object.entries(params)) suggested.push({ source: 'param', key: k, operator: 'equals', value: v });
  const q = new URL(t.url, 'http://x').searchParams;
  for (const [k, v] of q) suggested.push({ source: 'query', key: k, operator: 'equals', value: v });
  for (const h of INTERESTING_REQ_HEADERS) {
    if (t.reqHeaders[h]) suggested.push({ source: 'header', key: h, operator: 'equals', value: t.reqHeaders[h] });
  }
  try {
    const b = JSON.parse(t.reqBody);
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      for (const [k, v] of Object.entries(b).slice(0, 15)) {
        if (v === null || typeof v !== 'object') suggested.push({ source: 'body', key: `$.${k}`, operator: 'equals', value: String(v) });
      }
    }
  } catch {
    /* not json */
  }

  return {
    mock: {
      collectionId: null,
      name: `${t.method} ${t.path}`,
      enabled: true,
      priority: 0,
      method: (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(t.method) ? t.method : 'ANY') as MockInput['method'],
      pathPattern: pattern,
      conditionMode: 'all',
      conditions: [],
      response: { status: t.status, headers, body, delayMs: 0 },
      effects: [],
      script: '',
      createdFromTrafficId: t.id,
    },
    suggestedConditions: suggested,
  };
}
