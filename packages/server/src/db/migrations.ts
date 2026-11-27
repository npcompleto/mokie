/** Ordered list of schema migrations. Never edit an applied migration: append a new one. */
export const migrations: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE backends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'prefix',
    match_value TEXT NOT NULL DEFAULT '/',
    strip_prefix INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    headers_override TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE mocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT 'GET',
    path_pattern TEXT NOT NULL,
    condition_mode TEXT NOT NULL DEFAULT 'all',
    conditions TEXT NOT NULL DEFAULT '[]',
    response TEXT NOT NULL DEFAULT '{}',
    effects TEXT NOT NULL DEFAULT '[]',
    script TEXT NOT NULL DEFAULT '',
    created_from_traffic_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE state_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE flow_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    redirect_template TEXT NOT NULL DEFAULT '{{ctx.redirectUrl}}',
    ctas TEXT NOT NULL DEFAULT '[]',
    ttl_seconds INTEGER NOT NULL DEFAULT 3600
  );

  CREATE TABLE flow_sessions (
    token TEXT PRIMARY KEY,
    page_slug TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    chosen_cta TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    path TEXT NOT NULL,
    req_headers TEXT NOT NULL,
    req_body TEXT NOT NULL,
    status INTEGER NOT NULL,
    res_headers TEXT NOT NULL,
    res_body TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    mock_id INTEGER,
    backend_id INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX traffic_ts ON traffic(id DESC);
  `,
];
