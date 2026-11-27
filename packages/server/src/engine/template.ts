import Handlebars from 'handlebars';
import { randomInt, randomUUID } from 'node:crypto';
import { getIn, splitPath } from '../state/store.ts';

/** Hooks a template can call back into (flow session creation, etc.). */
export type TemplateRuntime = {
  flowUrl: (slug: string, ctx: Record<string, unknown>) => string;
  id: (name: string) => string;
};

export type TemplateContext = Record<string, unknown> & { __runtime?: TemplateRuntime };

const hb = Handlebars.create();

const isOptions = (v: unknown) => !!v && typeof v === 'object' && 'hash' in (v as any) && 'data' in (v as any);
const args = (a: unknown[]) => a.filter((x) => !isOptions(x));

hb.registerHelper({
  json: (v: unknown, pretty?: unknown) => JSON.stringify(v ?? null, null, pretty === true || pretty === 'pretty' ? 2 : undefined),
  uuid: () => randomUUID(),
  now: (fmt?: unknown) => {
    const d = new Date();
    if (fmt === 'epoch') return Math.floor(d.getTime() / 1000);
    if (fmt === 'epochMs') return d.getTime();
    if (fmt === 'date') return d.toISOString().slice(0, 10);
    return d.toISOString();
  },
  randomInt: (min: unknown, max: unknown) => randomInt(Number(min) || 0, (Number(max) || 1000) + 1),
  /** get obj 'a.b.c' — dynamic path lookup */
  get: (obj: unknown, path: unknown) => getIn(obj, splitPath(String(path ?? ''))),
  concat: (...a: unknown[]) => args(a).map((x) => (x == null ? '' : String(x))).join(''),
  default: (v: unknown, d: unknown) => (v === undefined || v === null || v === '' ? d : v),
  eq: (a: unknown, b: unknown) => String(a) === String(b),
  ne: (a: unknown, b: unknown) => String(a) !== String(b),
  gt: (a: unknown, b: unknown) => Number(a) > Number(b),
  lt: (a: unknown, b: unknown) => Number(a) < Number(b),
  and: (...a: unknown[]) => args(a).every(Boolean),
  or: (...a: unknown[]) => args(a).some(Boolean),
  not: (a: unknown) => !a,
  add: (a: unknown, b: unknown) => Number(a) + Number(b),
  sub: (a: unknown, b: unknown) => Number(a) - Number(b),
  mul: (a: unknown, b: unknown) => Number(a) * Number(b),
  upper: (s: unknown) => String(s ?? '').toUpperCase(),
  lower: (s: unknown) => String(s ?? '').toLowerCase(),
  length: (v: unknown) => (Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  base64: (s: unknown) => Buffer.from(String(s ?? '')).toString('base64'),
  urlencode: (s: unknown) => encodeURIComponent(String(s ?? '')),
  /** {{id 'order'}} — a uuid that stays the same for the whole request (effects + response) */
  id: function (name: unknown, options: Handlebars.HelperOptions) {
    const opts = (isOptions(name) ? name : options) as Handlebars.HelperOptions;
    const rt = (opts?.data?.root as TemplateContext)?.__runtime;
    const n = isOptions(name) ? 'default' : String(name);
    return rt ? rt.id(n) : randomUUID();
  },
  /** {{flowUrl 'payment' redirectUrl=body.redirect_url orderId=body.orderId}} */
  flowUrl: function (this: unknown, slug: unknown, options: Handlebars.HelperOptions) {
    const rt = (options.data?.root as TemplateContext)?.__runtime;
    if (!rt) throw new Error('flowUrl non disponibile in questo contesto');
    return rt.flowUrl(String(slug), { ...(options.hash ?? {}) });
  },
});

const cache = new Map<string, Handlebars.TemplateDelegate>();

/**
 * JSON bodies naturally produce `{{{` / `}}}` (e.g. `{"a": {{x}}}`), which Handlebars would read as
 * triple-stash. Since we never HTML-escape, triple-stash is useless: split those braces with a
 * marker character and strip it from the output.
 */
const MARK = '';
const protect = (t: string) => t.replace(/\{\{\{/g, `{${MARK}{{`).replace(/\}\}\}/g, `}}${MARK}}`);

function compile(template: string) {
  let fn = cache.get(template);
  if (!fn) {
    fn = hb.compile(protect(template), { noEscape: true, strict: false });
    if (cache.size > 2000) cache.clear();
    cache.set(template, fn);
  }
  return fn;
}

export function render(template: string, ctx: TemplateContext): string {
  if (!template.includes('{{')) return template;
  return compile(template)(ctx, { allowProtoPropertiesByDefault: false }).replaceAll(MARK, '');
}

/** Render, then parse as JSON when it looks like JSON (used for effect values). */
export function renderValue(template: string, ctx: TemplateContext): unknown {
  const out = render(template, ctx).trim();
  if (out === '') return '';
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

export function validateTemplate(template: string): string | null {
  try {
    hb.precompile(protect(template));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
