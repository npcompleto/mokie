import type { Condition, Mock } from '@mokie/shared';
import { JSONPath } from 'jsonpath-plus';
import { evalExpression } from './sandbox.ts';
import { render, type TemplateContext } from './template.ts';
import type { MokieRequest } from './types.ts';
import { getIn, splitPath } from '../state/store.ts';

// ---------------- path patterns ----------------

type CompiledPath = { re: RegExp; names: string[] };
const pathCache = new Map<string, CompiledPath>();

/**
 * Supported patterns:
 *  - `/orders/:id`          named segment
 *  - `/files/*`             wildcard (captured as `params.wild`)
 *  - `^/v[0-9]+/(?<x>.*)$`  raw regex (starts with ^), named groups become params
 */
export function compilePath(pattern: string): CompiledPath {
  const hit = pathCache.get(pattern);
  if (hit) return hit;
  let out: CompiledPath;
  if (pattern.startsWith('^')) {
    out = { re: new RegExp(pattern), names: [] };
  } else {
    const names: string[] = [];
    const src = pattern
      .replace(/\/+$/, '')
      .split('/')
      .map((seg) => {
        if (seg === '*') {
          names.push('wild');
          return '(.*)';
        }
        if (seg.startsWith(':')) {
          const opt = seg.endsWith('?');
          names.push(seg.slice(1, opt ? -1 : undefined));
          return opt ? '?([^/]*)' : '([^/]+)';
        }
        return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      })
      .join('/');
    out = { re: new RegExp(`^${src}/?$`), names };
  }
  pathCache.set(pattern, out);
  return out;
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const { re, names } = compilePath(pattern);
  const m = re.exec(path);
  if (!m) return null;
  const params: Record<string, string> = { ...(m.groups ?? {}) };
  names.forEach((n, i) => {
    const v = m[i + 1];
    params[n] = v === undefined ? '' : safeDecode(v);
  });
  return params;
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// ---------------- conditions ----------------

const toStr = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function compare(actual: unknown, op: Condition['operator'], expected: string): boolean {
  const exists = actual !== undefined && actual !== null;
  switch (op) {
    case 'exists':
      return exists;
    case 'notExists':
      return !exists;
    case 'equals':
      return exists && toStr(actual) === expected;
    case 'notEquals':
      return toStr(actual) !== expected;
    case 'contains':
      return exists && (Array.isArray(actual) ? actual.map(toStr).includes(expected) : toStr(actual).includes(expected));
    case 'notContains':
      return !(exists && (Array.isArray(actual) ? actual.map(toStr).includes(expected) : toStr(actual).includes(expected)));
    case 'regex':
      try {
        return exists && new RegExp(expected).test(toStr(actual));
      } catch {
        return false;
      }
    case 'gt':
      return exists && Number(actual) > Number(expected);
    case 'lt':
      return exists && Number(actual) < Number(expected);
  }
}

export type ConditionResult = { condition: Condition; actual: unknown; passed: boolean; error?: string };

export function evaluateCondition(c: Condition, req: MokieRequest, state: Record<string, unknown>, tctx: TemplateContext): ConditionResult {
  try {
    const key = render(c.key, tctx);
    const expected = render(c.value, tctx);
    let actual: unknown;
    switch (c.source) {
      case 'header':
        actual = req.headers[key.toLowerCase()];
        break;
      case 'query':
        actual = req.query[key];
        break;
      case 'cookie':
        actual = req.cookies[key];
        break;
      case 'param':
        actual = req.params[key];
        break;
      case 'body': {
        if (!key || key === '$') actual = req.rawBody;
        else if (req.body && typeof req.body === 'object') {
          const res = JSONPath({ path: key.startsWith('$') ? key : `$.${key}`, json: req.body as object, wrap: true });
          actual = Array.isArray(res) && res.length ? (res.length === 1 ? res[0] : res) : undefined;
        }
        break;
      }
      case 'state':
        actual = getIn(state, splitPath(key));
        break;
      case 'script': {
        const v = evalExpression(c.value, { ...tctx, req, state });
        return { condition: c, actual: v, passed: !!v };
      }
    }
    return { condition: c, actual, passed: compare(actual, c.operator, expected) };
  } catch (e) {
    return { condition: c, actual: undefined, passed: false, error: (e as Error).message };
  }
}

export type MockEvaluation = {
  mock: Mock;
  methodOk: boolean;
  pathOk: boolean;
  params: Record<string, string>;
  conditions: ConditionResult[];
  matched: boolean;
};

export function evaluateMock(
  mock: Mock,
  req: MokieRequest,
  state: Record<string, unknown>,
  makeCtx: (req: MokieRequest) => TemplateContext,
): MockEvaluation {
  const methodOk = mock.method === 'ANY' || mock.method === req.method;
  const params = matchPath(mock.pathPattern, req.path);
  const ev: MockEvaluation = { mock, methodOk, pathOk: !!params, params: params ?? {}, conditions: [], matched: false };
  if (!methodOk || !params) return ev;
  const r = { ...req, params };
  const tctx = makeCtx(r);
  ev.conditions = mock.conditions.map((c) => evaluateCondition(c, r, state, tctx));
  ev.matched =
    ev.conditions.length === 0 ||
    (mock.conditionMode === 'any' ? ev.conditions.some((c) => c.passed) : ev.conditions.every((c) => c.passed));
  return ev;
}

/** First matching mock in priority order (mocks must already be sorted). */
export function findMock(
  mocks: Mock[],
  req: MokieRequest,
  state: Record<string, unknown>,
  makeCtx: (req: MokieRequest) => TemplateContext,
): MockEvaluation | null {
  for (const m of mocks) {
    const ev = evaluateMock(m, req, state, makeCtx);
    if (ev.matched) return ev;
  }
  return null;
}
