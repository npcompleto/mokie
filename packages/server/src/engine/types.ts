import type { TrafficSource } from '@mokie/shared';

/** Framework-agnostic incoming request. */
export type IncomingReq = {
  method: string;
  /** path + query string, as received */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  remoteAddress?: string;
  protocol?: 'http' | 'https';
};

/** Parsed request exposed to conditions, templates and scripts. */
export type MokieRequest = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  /** parsed body: JSON value, form object, or raw text */
  body: unknown;
  rawBody: string;
  params: Record<string, string>;
  /** base URL as seen by the client, e.g. http://localhost:8080 */
  baseUrl: string;
};

export type OutgoingRes = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  source: TrafficSource;
  mockId?: number | null;
  backendId?: number | null;
  note?: string;
  /** decoded body for logging, when different from `body` (e.g. gzip) */
  logBody?: Buffer;
};
