import type {
  Backend,
  BackendInput,
  Collection,
  CollectionInput,
  FlowPage,
  FlowPageInput,
  FlowSession,
  Mock,
  MockInput,
  Settings,
  TrafficEntry,
  TrafficSummary,
} from '@mokie/shared';
import { type DB, json, now, parse } from './index.ts';

type Row = Record<string, any>;

export const DEFAULT_SETTINGS: Settings = {
  publicUrl: '',
  trafficRetention: 5000,
  maxBodyBytes: 256 * 1024,
  noBackendFallback: 'notFound',
};

/** All persistence lives here; one instance per DB. */
export class Repos {
  constructor(readonly db: DB) {}

  // ---------- settings ----------
  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[];
    const s: any = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = parse(r.value, s[r.key]);
    return s;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const st = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS) st.run(k, json(v));
    }
    return this.getSettings();
  }

  // ---------- backends ----------
  private toBackend = (r: Row): Backend => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    matchType: r.match_type,
    matchValue: r.match_value,
    stripPrefix: !!r.strip_prefix,
    enabled: !!r.enabled,
    priority: r.priority,
    headersOverride: parse(r.headers_override, {}),
  });
  listBackends(): Backend[] {
    return (this.db.prepare('SELECT * FROM backends ORDER BY priority DESC, id').all() as Row[]).map(this.toBackend);
  }
  getBackend(id: number): Backend | undefined {
    const r = this.db.prepare('SELECT * FROM backends WHERE id = ?').get(id) as Row | undefined;
    return r && this.toBackend(r);
  }
  createBackend(b: BackendInput): Backend {
    const r = this.db
      .prepare(
        `INSERT INTO backends (name, base_url, match_type, match_value, strip_prefix, enabled, priority, headers_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.name, b.baseUrl, b.matchType, b.matchValue, +b.stripPrefix, +b.enabled, b.priority, json(b.headersOverride));
    return this.getBackend(Number(r.lastInsertRowid))!;
  }
  updateBackend(id: number, b: BackendInput): Backend | undefined {
    this.db
      .prepare(
        `UPDATE backends SET name=?, base_url=?, match_type=?, match_value=?, strip_prefix=?, enabled=?, priority=?, headers_override=? WHERE id=?`,
      )
      .run(b.name, b.baseUrl, b.matchType, b.matchValue, +b.stripPrefix, +b.enabled, b.priority, json(b.headersOverride), id);
    return this.getBackend(id);
  }
  deleteBackend(id: number) {
    this.db.prepare('DELETE FROM backends WHERE id = ?').run(id);
  }

  // ---------- collections ----------
  private toCollection = (r: Row): Collection => ({
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: !!r.enabled,
  });
  listCollections(): Collection[] {
    return (this.db.prepare('SELECT * FROM collections ORDER BY name').all() as Row[]).map(this.toCollection);
  }
  getCollection(id: number): Collection | undefined {
    const r = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as Row | undefined;
    return r && this.toCollection(r);
  }
  createCollection(c: CollectionInput): Collection {
    const r = this.db
      .prepare('INSERT INTO collections (name, description, enabled) VALUES (?, ?, ?)')
      .run(c.name, c.description, +c.enabled);
    return this.getCollection(Number(r.lastInsertRowid))!;
  }
  updateCollection(id: number, c: CollectionInput) {
    this.db.prepare('UPDATE collections SET name=?, description=?, enabled=? WHERE id=?').run(c.name, c.description, +c.enabled, id);
    return this.getCollection(id);
  }
  deleteCollection(id: number) {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  }

  // ---------- mocks ----------
  private toMock = (r: Row): Mock => ({
    id: r.id,
    collectionId: r.collection_id ?? null,
    name: r.name,
    enabled: !!r.enabled,
    priority: r.priority,
    method: r.method,
    pathPattern: r.path_pattern,
    conditionMode: r.condition_mode,
    conditions: parse(r.conditions, []),
    response: parse(r.response, { status: 200, headers: {}, body: '', delayMs: 0 }),
    effects: parse(r.effects, []),
    script: r.script,
    createdFromTrafficId: r.created_from_traffic_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  listMocks(): Mock[] {
    return (this.db.prepare('SELECT * FROM mocks ORDER BY priority DESC, id').all() as Row[]).map(this.toMock);
  }
  /** Enabled mocks whose collection (if any) is enabled, in evaluation order. */
  activeMocks(): Mock[] {
    return (
      this.db
        .prepare(
          `SELECT m.* FROM mocks m LEFT JOIN collections c ON c.id = m.collection_id
           WHERE m.enabled = 1 AND (m.collection_id IS NULL OR c.enabled = 1)
           ORDER BY m.priority DESC, m.id`,
        )
        .all() as Row[]
    ).map(this.toMock);
  }
  getMock(id: number): Mock | undefined {
    const r = this.db.prepare('SELECT * FROM mocks WHERE id = ?').get(id) as Row | undefined;
    return r && this.toMock(r);
  }
  createMock(m: MockInput): Mock {
    const t = now();
    const r = this.db
      .prepare(
        `INSERT INTO mocks (collection_id, name, enabled, priority, method, path_pattern, condition_mode, conditions, response, effects, script, created_from_traffic_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.collectionId,
        m.name,
        +m.enabled,
        m.priority,
        m.method,
        m.pathPattern,
        m.conditionMode,
        json(m.conditions),
        json(m.response),
        json(m.effects),
        m.script,
        m.createdFromTrafficId,
        t,
        t,
      );
    return this.getMock(Number(r.lastInsertRowid))!;
  }
  updateMock(id: number, m: MockInput): Mock | undefined {
    this.db
      .prepare(
        `UPDATE mocks SET collection_id=?, name=?, enabled=?, priority=?, method=?, path_pattern=?, condition_mode=?, conditions=?, response=?, effects=?, script=?, updated_at=? WHERE id=?`,
      )
      .run(
        m.collectionId,
        m.name,
        +m.enabled,
        m.priority,
        m.method,
        m.pathPattern,
        m.conditionMode,
        json(m.conditions),
        json(m.response),
        json(m.effects),
        m.script,
        now(),
        id,
      );
    return this.getMock(id);
  }
  setMockEnabled(id: number, enabled: boolean) {
    this.db.prepare('UPDATE mocks SET enabled=?, updated_at=? WHERE id=?').run(+enabled, now(), id);
    return this.getMock(id);
  }
  deleteMock(id: number) {
    this.db.prepare('DELETE FROM mocks WHERE id = ?').run(id);
  }

  // ---------- flow pages ----------
  private toFlowPage = (r: Row): FlowPage => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    redirectTemplate: r.redirect_template,
    ctas: parse(r.ctas, []),
    ttlSeconds: r.ttl_seconds,
  });
  listFlowPages(): FlowPage[] {
    return (this.db.prepare('SELECT * FROM flow_pages ORDER BY slug').all() as Row[]).map(this.toFlowPage);
  }
  getFlowPage(id: number): FlowPage | undefined {
    const r = this.db.prepare('SELECT * FROM flow_pages WHERE id = ?').get(id) as Row | undefined;
    return r && this.toFlowPage(r);
  }
  getFlowPageBySlug(slug: string): FlowPage | undefined {
    const r = this.db.prepare('SELECT * FROM flow_pages WHERE slug = ?').get(slug) as Row | undefined;
    return r && this.toFlowPage(r);
  }
  createFlowPage(p: FlowPageInput): FlowPage {
    const r = this.db
      .prepare('INSERT INTO flow_pages (slug, title, description, redirect_template, ctas, ttl_seconds) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.slug, p.title, p.description, p.redirectTemplate, json(p.ctas), p.ttlSeconds);
    return this.getFlowPage(Number(r.lastInsertRowid))!;
  }
  updateFlowPage(id: number, p: FlowPageInput) {
    this.db
      .prepare('UPDATE flow_pages SET slug=?, title=?, description=?, redirect_template=?, ctas=?, ttl_seconds=? WHERE id=?')
      .run(p.slug, p.title, p.description, p.redirectTemplate, json(p.ctas), p.ttlSeconds, id);
    return this.getFlowPage(id);
  }
  deleteFlowPage(id: number) {
    this.db.prepare('DELETE FROM flow_pages WHERE id = ?').run(id);
  }

  // ---------- flow sessions ----------
  private toSession = (r: Row): FlowSession => ({
    token: r.token,
    pageSlug: r.page_slug,
    context: parse(r.context, {}),
    status: r.status,
    chosenCta: r.chosen_cta ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
  });
  createSession(token: string, pageSlug: string, context: Record<string, unknown>): FlowSession {
    this.db
      .prepare('INSERT INTO flow_sessions (token, page_slug, context, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(token, pageSlug, json(context), 'pending', now());
    return this.getSession(token)!;
  }
  getSession(token: string): FlowSession | undefined {
    const r = this.db.prepare('SELECT * FROM flow_sessions WHERE token = ?').get(token) as Row | undefined;
    return r && this.toSession(r);
  }
  completeSession(token: string, cta: string) {
    this.db
      .prepare(`UPDATE flow_sessions SET status='completed', chosen_cta=?, completed_at=? WHERE token=?`)
      .run(cta, now(), token);
  }
  expireSession(token: string) {
    this.db.prepare(`UPDATE flow_sessions SET status='expired' WHERE token=?`).run(token);
  }
  listSessions(limit = 200): FlowSession[] {
    return (this.db.prepare('SELECT * FROM flow_sessions ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(
      this.toSession,
    );
  }
  clearSessions() {
    this.db.prepare('DELETE FROM flow_sessions').run();
  }

  // ---------- traffic ----------
  private toTraffic = (r: Row): TrafficEntry => ({
    id: r.id,
    ts: r.ts,
    method: r.method,
    url: r.url,
    path: r.path,
    reqHeaders: parse(r.req_headers, {}),
    reqBody: r.req_body,
    status: r.status,
    resHeaders: parse(r.res_headers, {}),
    resBody: r.res_body,
    durationMs: r.duration_ms,
    source: r.source,
    mockId: r.mock_id ?? null,
    backendId: r.backend_id ?? null,
    note: r.note,
  });
  insertTraffic(e: Omit<TrafficEntry, 'id'>, retention: number): TrafficEntry {
    const r = this.db
      .prepare(
        `INSERT INTO traffic (ts, method, url, path, req_headers, req_body, status, res_headers, res_body, duration_ms, source, mock_id, backend_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.ts,
        e.method,
        e.url,
        e.path,
        json(e.reqHeaders),
        e.reqBody,
        e.status,
        json(e.resHeaders),
        e.resBody,
        e.durationMs,
        e.source,
        e.mockId,
        e.backendId,
        e.note,
      );
    const id = Number(r.lastInsertRowid);
    if (retention > 0 && id % 50 === 0) {
      this.db.prepare('DELETE FROM traffic WHERE id <= ?').run(id - retention);
    }
    return { ...e, id };
  }
  listTraffic(opts: { limit?: number; beforeId?: number; q?: string; source?: string }): TrafficSummary[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.beforeId) {
      where.push('id < ?');
      args.push(opts.beforeId);
    }
    if (opts.q) {
      where.push('(url LIKE ? OR method LIKE ?)');
      args.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    if (opts.source) {
      where.push('source = ?');
      args.push(opts.source);
    }
    const sql = `SELECT id, ts, method, url, path, status, duration_ms, source, mock_id, backend_id, note FROM traffic
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => {
      const { reqHeaders, reqBody, resHeaders, resBody, ...rest } = this.toTraffic({ ...r, req_headers: '{}', res_headers: '{}' });
      return rest;
    });
  }
  getTraffic(id: number): TrafficEntry | undefined {
    const r = this.db.prepare('SELECT * FROM traffic WHERE id = ?').get(id) as Row | undefined;
    return r && this.toTraffic(r);
  }
  clearTraffic() {
    this.db.prepare('DELETE FROM traffic').run();
  }
}
