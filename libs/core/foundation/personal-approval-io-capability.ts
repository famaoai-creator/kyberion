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
 *
 * G2: the live window is itself the authority (there is no store role). Every I/O made while a
 * window is entered is narrowed to the window and, for writes, to where the former
 * `personal_approval_store` role was effectively authorized (`personalApprovalIoNarrowing`,
 * applied by tier-guard); inside that the window authorizes what the former role's policy grant
 * covered (`personalApprovalGrantAuthorizes`). A continuation captured inside it (the window no
 * longer issued) or a window whose owner scope is no longer current admits nothing, as the role
 * held there admitted nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Issuance right of the personal approval owner window (G2). The former shared core role of this
 * name is gone; the name stays only in role-assumption-policy `shared_core_roles`, which decides
 * which processes may open the window (authority.ts assertStoreGrantIssuanceAllowed). It is not an
 * assumable authority role.
 */
export const PERSONAL_APPROVAL_GRANT_ISSUANCE_RIGHT = 'personal_approval_store';
type Window = Readonly<{
  path: string;
  writing: boolean;
  ownerHash: string;
  isCurrent: () => boolean;
  /** Roots the former role's policy grant let it write (named by the issuer). */
  writeRoots: readonly string[];
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
  run: () => T,
  writeRoots: readonly string[] = []
): T {
  if (!isCurrent())
    throw new Error('[PERSONAL_APPROVAL_SCOPE_REQUIRED] Current owner scope required');
  const window = Object.freeze({
    path: file,
    writing,
    ownerHash,
    isCurrent,
    writeRoots: Object.freeze([...writeRoots]),
  });
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
/**
 * Exact window admission: the live, current window's file (write / append only while writing),
 * its ancestors (read / metadata, and mkdir while writing) and product governance reads.
 */
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

function writeRootsCover(target: string): boolean {
  const roots = registry.storage.getStore()?.writeRoots ?? [];
  return roots.some((root) => within(target, root));
}

/** Is a window entered here (issued or captured, current or not)? */
export function personalApprovalWindowEntered(): boolean {
  return registry.storage.getStore() !== undefined;
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + '/');
}

/**
 * Reads the former role's policy grant also covered besides its write roots. The write roots
 * (the personal owner partitions and the Vitest approval store) are named by the issuer when it
 * opens the window. The role routed window I/O to its own policy grant, never to the runtime
 * default allow, so an ancestor above them (e.g. mkdir of `tenant-approvals/personal`) was refused
 * inside the window.
 */
const PRODUCT_READ_ROOT = 'knowledge/product';
const isWrite = (operation?: string) =>
  operation === 'write' || operation === 'append' || operation === 'mkdir';

/**
 * Deny-only narrowing of every I/O made while a window is entered: the exact window admission,
 * and for writes only under the former role's write roots (whatever the caller's own policy).
 * True when no window is entered.
 */
export function personalApprovalIoNarrowing(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  if (!personalApprovalWindowEntered()) return true;
  if (!personalApprovalIoAllowed(target, operation)) return false;
  return !isWrite(operation) || writeRootsCover(target);
}

/** Does the live window authorize this I/O? Its admission, under the former role's grant roots. */
export function personalApprovalGrantAuthorizes(
  target: string,
  operation: 'read' | 'write' | 'append' | 'mkdir' | 'metadata'
): boolean {
  if (!personalApprovalWindowEntered() || !personalApprovalIoAllowed(target, operation))
    return false;
  return writeRootsCover(target) || (!isWrite(operation) && within(target, PRODUCT_READ_ROOT));
}
