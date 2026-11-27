import vm from 'node:vm';

/**
 * Script execution via node:vm.
 * NOTE: node:vm is NOT a security boundary. Mokie is a local development tool and scripts are
 * authored by its users; the sandbox only exists to give scripts a clean scope and a CPU timeout.
 */

const SYNC_TIMEOUT_MS = 1000;
const ASYNC_TIMEOUT_MS = 15000;

const scriptCache = new Map<string, vm.Script>();
function compile(code: string, filename: string): vm.Script {
  let s = scriptCache.get(code);
  if (!s) {
    s = new vm.Script(code, { filename });
    if (scriptCache.size > 1000) scriptCache.clear();
    scriptCache.set(code, s);
  }
  return s;
}

const baseGlobals = () => ({
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Object,
  RegExp,
  Error,
  encodeURIComponent,
  decodeURIComponent,
  URL,
  URLSearchParams,
  parseInt,
  parseFloat,
  isNaN,
  Promise,
  setTimeout,
  structuredClone,
  btoa,
  atob,
});

/** Evaluate a boolean JS expression (used by `script` conditions). */
export function evalExpression(expr: string, scope: Record<string, unknown>): unknown {
  const script = compile(`(${expr}\n)`, 'condition.js');
  return script.runInNewContext({ ...baseGlobals(), ...scope }, { timeout: SYNC_TIMEOUT_MS });
}

/** Run a mock script body. The body may use `await` and `return`. */
export async function runScript(code: string, scope: Record<string, unknown>): Promise<unknown> {
  const script = compile(`(async () => {\n${code}\n})()`, 'mock-script.js');
  const promise = script.runInNewContext({ ...baseGlobals(), ...scope }, { timeout: SYNC_TIMEOUT_MS }) as Promise<unknown>;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`script timeout (${ASYNC_TIMEOUT_MS}ms)`)), ASYNC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function checkSyntax(code: string): string | null {
  try {
    new vm.Script(`(async () => {\n${code}\n})()`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
