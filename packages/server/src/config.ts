import { resolve } from 'node:path';

/** Path prefix of the admin UI and API on the single Mokie port. Never forwarded to backends. */
export const ADMIN_PREFIX = '/_admin';

export type MokieConfig = {
  /** the single port: mocks/proxy on every path, admin under /_admin/ */
  port: number;
  host: string;
  dbPath: string;
  /** directory with the built admin UI (served under /_admin/ when present) */
  uiDir: string;
  /** default public base URL for flow pages (overridable from the UI settings) */
  publicUrl: string;
};

export function loadConfig(env = process.env): MokieConfig {
  return {
    port: Number(env.MOKIE_PORT ?? env.MOKIE_PROXY_PORT ?? 8080),
    host: env.MOKIE_HOST ?? '0.0.0.0',
    dbPath: env.MOKIE_DB_PATH ? resolve(env.MOKIE_DB_PATH) : new URL('../../../data/mokie.db', import.meta.url).pathname,
    uiDir: resolve(env.MOKIE_UI_DIR ?? new URL('../../ui/dist', import.meta.url).pathname),
    publicUrl: env.MOKIE_PUBLIC_URL ?? '',
  };
}
