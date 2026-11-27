import { type DB, json, now, parse, tx } from '../db/index.ts';

/** Split a dotted path: `orders.123.status` → ['orders','123','status']. Supports `a[0].b` too. */
export function splitPath(path: string): string[] {
  return path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getIn(obj: unknown, parts: string[]): unknown {
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setIn(obj: Record<string, any>, parts: string[], value: unknown) {
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteIn(obj: Record<string, any>, parts: string[]) {
  const parent = getIn(obj, parts.slice(0, -1)) as any;
  if (parent && typeof parent === 'object') {
    const k = parts[parts.length - 1];
    if (Array.isArray(parent) && /^\d+$/.test(k)) parent.splice(Number(k), 1);
    else delete parent[k];
  }
}

export type StateListener = (keys: string[]) => void;

/**
 * Shared, persistent state. The whole tree is kept in memory and every top-level key
 * is persisted as a row (write-through), so state survives restarts and is shared by all mocks.
 */
export class StateStore {
  private data: Record<string, any> = {};
  private listeners = new Set<StateListener>();

  constructor(private db: DB) {
    for (const r of db.prepare('SELECT key, value FROM state').all() as { key: string; value: string }[]) {
      this.data[r.key] = parse(r.value, null);
    }
  }

  onChange(l: StateListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  all(): Record<string, any> {
    return structuredClone(this.data);
  }

  get(path: string): unknown {
    const parts = splitPath(path);
    if (!parts.length) return this.all();
    const v = getIn(this.data, parts);
    return v === undefined ? undefined : structuredClone(v);
  }

  set(path: string, value: unknown) {
    const parts = splitPath(path);
    if (!parts.length) {
      this.replaceAll((value ?? {}) as Record<string, any>);
      return;
    }
    setIn(this.data, parts, structuredClone(value));
    this.persist([parts[0]]);
  }

  merge(path: string, value: unknown) {
    const cur = this.get(path);
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && value && typeof value === 'object') {
      this.set(path, { ...(cur as object), ...(value as object) });
    } else this.set(path, value);
  }

  incr(path: string, by = 1): number {
    const n = Number(this.get(path) ?? 0) + by;
    this.set(path, n);
    return n;
  }

  push(path: string, value: unknown): number {
    const cur = this.get(path);
    const arr = Array.isArray(cur) ? cur : [];
    arr.push(value);
    this.set(path, arr);
    return arr.length;
  }

  remove(path: string) {
    const parts = splitPath(path);
    if (!parts.length) return this.replaceAll({});
    if (parts.length === 1) delete this.data[parts[0]];
    else deleteIn(this.data, parts);
    this.persist([parts[0]]);
  }

  replaceAll(next: Record<string, any>) {
    const keys = new Set([...Object.keys(this.data), ...Object.keys(next)]);
    this.data = structuredClone(next);
    this.persist([...keys]);
  }

  /** Run several mutations atomically in the DB. */
  batch<T>(fn: () => T): T {
    const before = structuredClone(this.data);
    try {
      return tx(this.db, fn);
    } catch (e) {
      this.data = before;
      throw e;
    }
  }

  private persist(keys: string[]) {
    tx(this.db, () => {
      const up = this.db.prepare(
        'INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      );
      const del = this.db.prepare('DELETE FROM state WHERE key = ?');
      for (const k of keys) {
        if (k in this.data && this.data[k] !== undefined) up.run(k, json(this.data[k]), now());
        else del.run(k);
      }
    });
    for (const l of this.listeners) l(keys);
  }

  // ---------- snapshots ----------
  listSnapshots() {
    return this.db.prepare('SELECT id, name, created_at AS createdAt FROM state_snapshots ORDER BY id DESC').all();
  }
  saveSnapshot(name: string) {
    const r = this.db
      .prepare('INSERT INTO state_snapshots (name, data, created_at) VALUES (?, ?, ?)')
      .run(name, json(this.data), now());
    return Number(r.lastInsertRowid);
  }
  restoreSnapshot(id: number): boolean {
    const r = this.db.prepare('SELECT data FROM state_snapshots WHERE id = ?').get(id) as { data: string } | undefined;
    if (!r) return false;
    this.replaceAll(parse(r.data, {}));
    return true;
  }
  deleteSnapshot(id: number) {
    this.db.prepare('DELETE FROM state_snapshots WHERE id = ?').run(id);
  }
}
