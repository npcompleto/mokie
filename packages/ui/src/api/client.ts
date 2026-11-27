import type {
  Backend,
  BackendInput,
  Collection,
  CollectionInput,
  Condition,
  ExportBundle,
  FlowPage,
  FlowPageInput,
  FlowSession,
  Mock,
  MockInput,
  Settings,
  TrafficEntry,
  TrafficSummary,
} from '@mokie/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** admin API base on the single Mokie port */
export const API_BASE = '/_admin/api';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const details = data?.details;
    const issues = Array.isArray(details)
      ? details.map((d: any) => (typeof d === 'string' ? d : `${(d.path ?? []).join('.')}: ${d.message}`)).join('\n')
      : '';
    throw new ApiError(issues ? `${data?.error}\n${issues}` : (data?.error ?? res.statusText), res.status, details);
  }
  return data as T;
}

export type Explain = {
  request: { method: string; path: string; query: Record<string, unknown>; params: Record<string, string> };
  winner: { id: number; name: string } | null;
  backend: { id: number; name: string; baseUrl: string } | null;
  evaluations: {
    mockId: number;
    name: string;
    active: boolean;
    methodOk: boolean;
    pathOk: boolean;
    matched: boolean;
    params: Record<string, string>;
    conditions: { condition: Condition; actual: unknown; passed: boolean; error?: string }[];
  }[];
};

export type CallResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  source: string;
  mockId: number | null;
  note: string;
  durationMs: number;
};

export const api = {
  health: () => call<{ ok: boolean; port: number }>('GET', '/health'),
  settings: () => call<Settings>('GET', '/settings'),
  saveSettings: (s: Partial<Settings>) => call<Settings>('PUT', '/settings', s),

  backends: () => call<Backend[]>('GET', '/backends'),
  createBackend: (b: BackendInput) => call<Backend>('POST', '/backends', b),
  updateBackend: (id: number, b: BackendInput) => call<Backend>('PUT', `/backends/${id}`, b),
  deleteBackend: (id: number) => call('DELETE', `/backends/${id}`),

  collections: () => call<Collection[]>('GET', '/collections'),
  createCollection: (c: CollectionInput) => call<Collection>('POST', '/collections', c),
  updateCollection: (id: number, c: CollectionInput) => call<Collection>('PUT', `/collections/${id}`, c),
  deleteCollection: (id: number) => call('DELETE', `/collections/${id}`),

  mocks: () => call<Mock[]>('GET', '/mocks'),
  mock: (id: number) => call<Mock>('GET', `/mocks/${id}`),
  createMock: (m: MockInput) => call<Mock>('POST', '/mocks', m),
  updateMock: (id: number, m: MockInput) => call<Mock>('PUT', `/mocks/${id}`, m),
  setMockEnabled: (id: number, enabled: boolean) => call<Mock>('PATCH', `/mocks/${id}/enabled`, { enabled }),
  duplicateMock: (id: number) => call<Mock>('POST', `/mocks/${id}/duplicate`),
  deleteMock: (id: number) => call('DELETE', `/mocks/${id}`),
  explain: (r: { method: string; url: string; headers: Record<string, string>; body: string }) =>
    call<Explain>('POST', '/mocks/explain', r),
  /** real call through the proxy pipeline: applies state effects and is recorded in traffic */
  callEndpoint: (r: { method: string; url: string; headers: Record<string, string>; body: string }) =>
    call<CallResult>('POST', '/mocks/call', r),

  state: () => call<Record<string, unknown>>('GET', '/state'),
  replaceState: (s: Record<string, unknown>) => call<Record<string, unknown>>('PUT', '/state', s),
  clearState: () => call('DELETE', '/state'),
  snapshots: () => call<{ id: number; name: string; createdAt: string }[]>('GET', '/state/snapshots'),
  saveSnapshot: (name: string) => call('POST', '/state/snapshots', { name }),
  restoreSnapshot: (id: number) => call('POST', `/state/snapshots/${id}/restore`),
  deleteSnapshot: (id: number) => call('DELETE', `/state/snapshots/${id}`),

  flowPages: () => call<FlowPage[]>('GET', '/flow-pages'),
  createFlowPage: (p: FlowPageInput) => call<FlowPage>('POST', '/flow-pages', p),
  updateFlowPage: (id: number, p: FlowPageInput) => call<FlowPage>('PUT', `/flow-pages/${id}`, p),
  deleteFlowPage: (id: number) => call('DELETE', `/flow-pages/${id}`),
  testFlowSession: (id: number, context: Record<string, unknown>) =>
    call<{ token: string; url: string }>('POST', `/flow-pages/${id}/sessions`, { context }),
  flowSessions: () => call<FlowSession[]>('GET', '/flow-sessions'),
  clearFlowSessions: () => call('DELETE', '/flow-sessions'),

  traffic: (p: { q?: string; source?: string; beforeId?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '') as [string, string][]);
    return call<TrafficSummary[]>('GET', `/traffic?${qs}`);
  },
  trafficEntry: (id: number) => call<TrafficEntry>('GET', `/traffic/${id}`),
  trafficToMock: (id: number) => call<{ mock: MockInput; suggestedConditions: Condition[] }>('POST', `/traffic/${id}/to-mock`),
  clearTraffic: () => call('DELETE', '/traffic'),

  exportBundle: (withState: boolean) => call<ExportBundle>('GET', `/export${withState ? '?state=1' : ''}`),
  importBundle: (b: unknown, replace: boolean) =>
    call<Record<string, number>>('POST', `/import${replace ? '?mode=replace' : ''}`, b),
};
