import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { withLockSync } from '../foundation/lock-utils.js';

type Lease = { readonly key: string; active: boolean };
const KEY = Symbol.for('kyberion.core.engine-runtime-preferences-transaction.v1');
type Registry = { storage: AsyncLocalStorage<Lease> };
const shared = globalThis as typeof globalThis & { [KEY]?: Registry };
const { storage } = shared[KEY] ?? (shared[KEY] = { storage: new AsyncLocalStorage<Lease>() });

/** Internal profile transaction; no role grants and no caller-supplied HTTP target. */
export function withEngineRuntimePreferencesTransaction<T>(
  relativeProfilePath: string,
  action: () => T
): T {
  if (
    !relativeProfilePath ||
    relativeProfilePath.includes('\\') ||
    relativeProfilePath.includes('\0') ||
    relativeProfilePath.includes(':') ||
    path.posix.isAbsolute(relativeProfilePath) ||
    path.posix.normalize(relativeProfilePath) !== relativeProfilePath ||
    relativeProfilePath === '..' ||
    relativeProfilePath.startsWith('../') ||
    !relativeProfilePath.endsWith('/onboarding/engine-runtime.json')
  )
    throw new Error('[ENGINE_RUNTIME_TRANSACTION_TARGET_INVALID]');
  const key =
    'engine-runtime-operator:' + createHash('sha256').update(relativeProfilePath).digest('hex');
  const invoke = () => {
    const result = action();
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    )
      throw new Error('[ENGINE_RUNTIME_TRANSACTION_SYNC_REQUIRED]');
    return result;
  };
  const inherited = storage.getStore();
  if (inherited?.active && inherited.key === key) return invoke();
  return withLockSync(key, () => {
    const lease: Lease = { key, active: true };
    try {
      return storage.run(lease, invoke);
    } finally {
      lease.active = false;
    }
  });
}
