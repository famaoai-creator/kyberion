/** Foundation-only exact workspace IO window; issuer validates scope, physical partition and live claim. */
import { AsyncLocalStorage } from 'node:async_hooks';
export const TASK_SOURCE_WORKSPACE_ROLE = 'task_source_workspace';
type IoWindow = Readonly<{
  target: string;
  writing: boolean;
  assertCurrent: () => void;
}>;
const KEY = Symbol.for('kyberion.core.task-source-workspace-io.v1');
type Registry = { access: AsyncLocalStorage<IoWindow>; issued: WeakSet<IoWindow> };
const globalRegistry = globalThis as typeof globalThis & { [KEY]?: Registry };
const existing = globalRegistry[KEY];
if (
  existing &&
  (!(existing.access instanceof AsyncLocalStorage) || !(existing.issued instanceof WeakSet))
)
  throw new Error('[TASK_SOURCE_SCOPE_DENIED] Invalid shared workspace IO registry');
const registry =
  existing ??
  (globalRegistry[KEY] = {
    access: new AsyncLocalStorage<IoWindow>(),
    issued: new WeakSet<IoWindow>(),
  });
const access = registry.access;

function currentWindow(): IoWindow | undefined {
  const window = access.getStore();
  return window &&
    registry.issued.has(window) &&
    typeof window.target === 'string' &&
    typeof window.writing === 'boolean' &&
    typeof window.assertCurrent === 'function'
    ? window
    : undefined;
}

export function taskSourceWorkspaceIoActive(): boolean {
  const current = currentWindow();
  if (!current) return false;
  current.assertCurrent();
  return true;
}

export function withTaskSourceWorkspaceCapability<T>(
  target: string,
  writing: boolean,
  assertCurrent: () => void,
  run: () => T
): T {
  assertCurrent();
  const window = Object.freeze({ target, writing, assertCurrent });
  registry.issued.add(window);
  try {
    return access.run(window, run);
  } finally {
    registry.issued.delete(window);
  }
}
export function taskSourceWorkspaceIoAllowed(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  const current = currentWindow();
  if (!current) return false;
  current.assertCurrent();
  if ((operation === 'read' || operation === 'metadata') && target.startsWith('knowledge/product/'))
    return true;
  if (operation === 'write') return current.writing && target === current.target;
  if (operation === 'append') return false;
  if (operation === 'mkdir') return current.writing && current.target.startsWith(target + '/');
  return target === current.target || current.target.startsWith(target + '/');
}
