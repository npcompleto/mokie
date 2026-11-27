import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { notifications } from '@mantine/notifications';
import { API_BASE } from './api/client.ts';

// ---------------- hash router ----------------
const subscribeHash = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}
export const navigate = (path: string) => {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
};

// ---------------- live events (SSE) ----------------
type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
function ensureSource() {
  if (source) return;
  source = new EventSource(`${API_BASE}/events`);
  for (const ev of ['traffic', 'state', 'config']) {
    source.addEventListener(ev, (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      handlers.get(ev)?.forEach((h) => h(data));
    });
  }
}
export function useEvent(event: 'traffic' | 'state' | 'config', handler: Handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureSource();
    const h: Handler = (d) => ref.current(d);
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(h);
    return () => void handlers.get(event)!.delete(h);
  }, [event]);
}

// ---------------- data loading ----------------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return fn()
      .then((d) => {
        setData(d);
        return d;
      })
      .catch((e) => {
        notifyError(e);
        return undefined;
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, setData, loading, reload };
}

export const notifyError = (e: unknown) =>
  notifications.show({ color: 'red', title: 'Errore', message: <string>(e as Error)?.message ?? String(e), autoClose: 8000, style: { whiteSpace: 'pre-line' } });
export const notifyOk = (message: string) => notifications.show({ color: 'teal', message, autoClose: 2500 });

/** run an async action, notifying errors; returns the result or undefined */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) notifyOk(ok);
    return r;
  } catch (e) {
    notifyError(e);
    return undefined;
  }
}

// ---------------- draft handoff (traffic → mock editor) ----------------
let pendingDraft: unknown = null;
export const setPendingDraft = (d: unknown) => (pendingDraft = d);
export const takePendingDraft = <T,>(): T | null => {
  const d = pendingDraft as T | null;
  pendingDraft = null;
  return d;
};
