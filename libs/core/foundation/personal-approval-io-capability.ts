/** Foundation-only personal approval capability; canonical owner checks stay at the issuer. */
import { AsyncLocalStorage } from 'node:async_hooks';
export const PERSONAL_APPROVAL_STORE_ROLE = 'personal_approval_store';
type Window = Readonly<{
  path: string;
  writing: boolean;
  ownerHash: string;
  isCurrent: () => boolean;
}>;
const KEY = Symbol.for('kyberion.core.personal-approval-io.v1');
type Registry = { storage: AsyncLocalStorage<Window>; issued: WeakSet<Window> };
const globalRegistry = globalThis as typeof globalThis & { [KEY]?: Registry };
const prior = globalRegistry[KEY];
if (prior && (!(prior.storage instanceof AsyncLocalStorage) || !(prior.issued instanceof WeakSet)))
  throw new Error('[PERSONAL_APPROVAL_SCOPE_REQUIRED] Invalid runtime registry');
const registry =
  prior ??
  (globalRegistry[KEY] = {
    storage: new AsyncLocalStorage<Window>(),
    issued: new WeakSet<Window>(),
  });
export function withPersonalApprovalCapability<T>(
  ownerHash: string,
  file: string,
  writing: boolean,
  isCurrent: () => boolean,
  run: () => T
): T {
  if (!isCurrent())
    throw new Error('[PERSONAL_APPROVAL_SCOPE_REQUIRED] Current owner scope required');
  const window = Object.freeze({ path: file, writing, ownerHash, isCurrent });
  registry.issued.add(window);
  try {
    return registry.storage.run(window, run);
  } finally {
    registry.issued.delete(window);
  }
}
export function personalApprovalIoAllowed(
  target?: string,
  operation?: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  const window = registry.storage.getStore();
  if (!window || !registry.issued.has(window) || !window.isCurrent()) return false;
  if (target === undefined) return true;
  if ((operation === 'read' || operation === 'metadata') && target.startsWith('knowledge/product/'))
    return true;
  if (operation === 'write' || operation === 'append')
    return window.writing && target === window.path;
  if (operation === 'mkdir')
    return window.writing && (target === window.path || window.path.startsWith(target + '/'));
  return target === window.path || window.path.startsWith(target + '/');
}
