import type { Effect } from '@mokie/shared';
import type { StateStore } from '../state/store.ts';
import { render, renderValue, type TemplateContext } from './template.ts';

/** Apply declarative state effects atomically. Path and value are templates. */
export function applyEffects(effects: Effect[], state: StateStore, ctx: TemplateContext) {
  if (!effects.length) return;
  state.batch(() => {
    for (const e of effects) {
      const path = render(e.path, ctx).trim();
      switch (e.op) {
        case 'set':
          state.set(path, renderValue(e.value, ctx));
          break;
        case 'merge':
          state.merge(path, renderValue(e.value, ctx));
          break;
        case 'incr': {
          const by = e.value.trim() === '' ? 1 : Number(renderValue(e.value, ctx));
          state.incr(path, Number.isFinite(by) ? by : 1);
          break;
        }
        case 'push':
          state.push(path, renderValue(e.value, ctx));
          break;
        case 'remove':
          state.remove(path);
          break;
      }
      // later effects see earlier ones
      ctx.state = state.all();
    }
  });
}
