import { describe, expect, it } from 'vitest';
import { matchPath, compare } from '../src/engine/matcher.ts';
import { render, renderValue } from '../src/engine/template.ts';
import { inferPathPattern } from '../src/traffic/toMock.ts';
import { openDb } from '../src/db/index.ts';
import { StateStore } from '../src/state/store.ts';
import { applyEffects } from '../src/engine/effects.ts';
import { runScript, evalExpression } from '../src/engine/sandbox.ts';

describe('matchPath', () => {
  it('named params', () => {
    expect(matchPath('/orders/:id', '/orders/42')).toEqual({ id: '42' });
    expect(matchPath('/orders/:id', '/orders/42/')).toEqual({ id: '42' });
    expect(matchPath('/orders/:id', '/orders')).toBeNull();
    expect(matchPath('/a/:x/b/:y', '/a/1/b/2')).toEqual({ x: '1', y: '2' });
  });
  it('wildcard and regex', () => {
    expect(matchPath('/files/*', '/files/a/b.txt')).toEqual({ wild: 'a/b.txt' });
    expect(matchPath('^/v(?<ver>\\d+)/ping$', '/v2/ping')).toEqual({ ver: '2' });
    expect(matchPath('/api/*.json', '/api/x.json')).toEqual({});
  });
});

describe('compare', () => {
  it('operators', () => {
    expect(compare('a', 'equals', 'a')).toBe(true);
    expect(compare(undefined, 'exists', '')).toBe(false);
    expect(compare(undefined, 'notExists', '')).toBe(true);
    expect(compare('hello', 'contains', 'ell')).toBe(true);
    expect(compare(['x', 'y'], 'contains', 'y')).toBe(true);
    expect(compare('abc123', 'regex', '^abc\\d+$')).toBe(true);
    expect(compare(5, 'gt', '3')).toBe(true);
    expect(compare({ a: 1 }, 'equals', '{"a":1}')).toBe(true);
  });
});

describe('template', () => {
  it('renders context and helpers', () => {
    const ctx = { params: { id: '7' }, state: { orders: { '7': { status: 'PAID' } } }, body: { items: [1, 2] } };
    expect(render('{"id": "{{params.id}}"}', ctx)).toBe('{"id": "7"}');
    expect(render(`{{get state (concat 'orders.' params.id '.status')}}`, ctx)).toBe('PAID');
    expect(render('{{json body.items}}', ctx)).toBe('[1,2]');
    expect(render('{{#if (eq params.id "7")}}yes{{else}}no{{/if}}', ctx)).toBe('yes');
    expect(render('<{{params.id}}>&', ctx)).toBe('<7>&'); // no HTML escaping
    expect(renderValue('{"a": {{params.id}}}', ctx)).toEqual({ a: 7 });
    expect(renderValue('plain', ctx)).toBe('plain');
  });
});

describe('inferPathPattern', () => {
  it('replaces ids', () => {
    expect(inferPathPattern('/orders/123/items/550e8400-e29b-41d4-a716-446655440000').pattern).toBe('/orders/:orderId/items/:itemId');
    expect(inferPathPattern('/health').pattern).toBe('/health');
  });
});

describe('state + effects', () => {
  it('applies effects with templates and persists', () => {
    const db = openDb(':memory:');
    const s = new StateStore(db);
    applyEffects(
      [
        { op: 'set', path: 'orders.{{params.id}}', value: '{"status":"NEW"}' },
        { op: 'merge', path: 'orders.{{params.id}}', value: '{"amount": 10}' },
        { op: 'incr', path: 'counters.orders', value: '' },
        { op: 'push', path: 'log', value: '"created {{params.id}}"' },
      ],
      s,
      { params: { id: '9' } },
    );
    expect(s.all()).toEqual({ orders: { '9': { status: 'NEW', amount: 10 } }, counters: { orders: 1 }, log: ['created 9'] });
    // reloaded from DB
    expect(new StateStore(db).all()).toEqual(s.all());
    s.remove('orders.9');
    expect(s.get('orders')).toEqual({});
  });
});

describe('sandbox', () => {
  it('runs scripts and expressions', async () => {
    expect(await runScript('return a + 1', { a: 1 })).toBe(2);
    expect(await runScript('await sleep(1); return "ok"', { sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) })).toBe('ok');
    expect(evalExpression('req.n > 2', { req: { n: 3 } })).toBe(true);
    await expect(runScript('while(true){}', {})).rejects.toThrow(/timed out/i);
  });
});
