import { z } from 'zod';

export const HTTP_METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export const OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'regex',
  'exists',
  'notExists',
  'gt',
  'lt',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const CONDITION_SOURCES = ['header', 'query', 'cookie', 'param', 'body', 'state', 'script'] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];

/**
 * A single activation condition.
 * - header/query/cookie/param: `key` is the name
 * - body: `key` is a JSONPath (e.g. `$.user.id`) — empty key means the whole raw body
 * - state: `key` is a dotted state path (e.g. `orders.123.status`), templates allowed (`orders.{{params.id}}.status`)
 * - script: `value` is a JS expression returning a boolean (`key` ignored)
 */
export const ConditionSchema = z.object({
  source: z.enum(CONDITION_SOURCES),
  key: z.string().default(''),
  operator: z.enum(OPERATORS).default('equals'),
  value: z.string().default(''),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const EFFECT_OPS = ['set', 'merge', 'incr', 'push', 'remove'] as const;
/** A declarative state mutation. `path` and `value` support Handlebars templates; `value` is parsed as JSON when possible. */
export const EffectSchema = z.object({
  op: z.enum(EFFECT_OPS),
  path: z.string(),
  value: z.string().default(''),
});
export type Effect = z.infer<typeof EffectSchema>;

export const ResponseSpecSchema = z.object({
  status: z.number().int().min(100).max(599).default(200),
  headers: z.record(z.string()).default({ 'content-type': 'application/json' }),
  body: z.string().default(''),
  delayMs: z.number().int().min(0).default(0),
});
export type ResponseSpec = z.infer<typeof ResponseSpecSchema>;

export const MockInputSchema = z.object({
  collectionId: z.number().int().nullable().default(null),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  method: z.enum(HTTP_METHODS).default('GET'),
  pathPattern: z.string().min(1),
  /** `all` = every condition must match (AND), `any` = at least one (OR) */
  conditionMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(ConditionSchema).default([]),
  response: ResponseSpecSchema.default({}),
  effects: z.array(EffectSchema).default([]),
  /** Optional JS script. When set it takes over response generation. */
  script: z.string().default(''),
  createdFromTrafficId: z.number().int().nullable().default(null),
});
export type MockInput = z.infer<typeof MockInputSchema>;
export type Mock = MockInput & { id: number; createdAt: string; updatedAt: string };

export const CollectionInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
});
export type CollectionInput = z.infer<typeof CollectionInputSchema>;
export type Collection = CollectionInput & { id: number };

export const BackendInputSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  matchType: z.enum(['prefix', 'host']).default('prefix'),
  /** prefix: path prefix like `/api` (`/` matches everything); host: Host header value */
  matchValue: z.string().default('/'),
  stripPrefix: z.boolean().default(false),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  headersOverride: z.record(z.string()).default({}),
});
export type BackendInput = z.infer<typeof BackendInputSchema>;
export type Backend = BackendInput & { id: number };

export const CtaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** visual style */
  color: z.enum(['green', 'red', 'orange', 'gray', 'blue']).default('blue'),
  outcome: z.string().default(''),
  /** query params appended to the redirect url; values are templates (`{{ctx.orderId}}`) */
  redirectParams: z.record(z.string()).default({}),
  effects: z.array(EffectSchema).default([]),
  delayMs: z.number().int().min(0).default(0),
});
export type Cta = z.infer<typeof CtaSchema>;

export const FlowPageInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-_]+$/i, 'solo lettere, numeri, - e _'),
  title: z.string().min(1),
  description: z.string().default(''),
  /** template for redirect target; defaults to `{{ctx.redirectUrl}}` */
  redirectTemplate: z.string().default('{{ctx.redirectUrl}}'),
  ctas: z.array(CtaSchema).default([]),
  /** session time-to-live in seconds, 0 = never expire */
  ttlSeconds: z.number().int().min(0).default(3600),
});
export type FlowPageInput = z.infer<typeof FlowPageInputSchema>;
export type FlowPage = FlowPageInput & { id: number };

export type FlowSession = {
  token: string;
  pageSlug: string;
  context: Record<string, unknown>;
  status: 'pending' | 'completed' | 'expired';
  chosenCta: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type TrafficSource = 'mock' | 'proxy' | 'flow' | 'fallback' | 'error';
export type TrafficEntry = {
  id: number;
  ts: string;
  method: string;
  url: string;
  path: string;
  reqHeaders: Record<string, string>;
  reqBody: string;
  status: number;
  resHeaders: Record<string, string>;
  resBody: string;
  durationMs: number;
  source: TrafficSource;
  mockId: number | null;
  backendId: number | null;
  note: string;
};
export type TrafficSummary = Omit<TrafficEntry, 'reqHeaders' | 'reqBody' | 'resHeaders' | 'resBody'>;

export type Settings = {
  publicUrl: string;
  trafficRetention: number;
  maxBodyBytes: number;
  /** what to do when no mock matches and no backend matches */
  noBackendFallback: 'notFound' | 'badGateway';
};

export const ExportBundleSchema = z.object({
  version: z.literal(1),
  backends: z.array(BackendInputSchema).default([]),
  collections: z.array(CollectionInputSchema.extend({ key: z.string() })).default([]),
  mocks: z.array(MockInputSchema.omit({ collectionId: true }).extend({ collection: z.string().nullable().default(null) })).default([]),
  flowPages: z.array(FlowPageInputSchema).default([]),
  state: z.record(z.unknown()).optional(),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;
