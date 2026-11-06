/**
 * Foundation-only personal approval capability; canonical owner checks stay at the issuer
 * (governance/personal-approval-runtime.ts, import boundary test
 * tests/personal-approval-capability-boundary.test.ts).
 *
 * G2: the window over one exact owner file is module-private: its AsyncLocalStorage and
 * issued set live in this module instance only (no globalThis registry; a second instance of
 * @agent/core neither sees nor honours it, scripts/check_core_single_instance.ts keeps a
 * production process on one instance). It is synchronous: it ends when the callback returns, a
 * thenable result is refused, and a captured continuation finds no window.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
export const PERSONAL_APPROVAL_STORE_ROLE = 'personal_approval_store';
type Window = Readonly<{
  path: string;
  writing: boolean;
  ownerHash: string;
  isCurrent: () => boolean;
}>;
const registry = {
  storage: new AsyncLocalStorage<Window>(),
  issued: new WeakSet<Window>(),
};
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
    return registry.storage.run(window, () => {
      const result = run();
      if (
        result &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error(
          '[PERSONAL_APPROVAL_SCOPE_REQUIRED] Personal approval IO is synchronous only'
        );
      }
      return result;
    });
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
