import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireLock, releaseLock, withLockSync } from '../foundation/lock-utils.js';

// Reuse the management lock so a rolling restart still excludes old writers.
export const ENTITY_LIFECYCLE_LOCK = 'surface-management-mutations';
const ownership = new AsyncLocalStorage<{ active: boolean }>();
let asyncOwner = false;

export function withEntityLifecycleLock<T>(mutate: () => T): T {
  if (ownership.getStore()?.active) return mutate();
  return withLockSync(
    ENTITY_LIFECYCLE_LOCK,
    () => {
      const owner = { active: true };
      try {
        return ownership.run(owner, mutate);
      } finally {
        owner.active = false;
      }
    },
    asyncOwner ? 0 : undefined
  );
}

/** Acquire before entering a narrower surface resource grant. */
export async function withEntityLifecycleLockAsync<T>(
  mutate: () => Promise<T>,
  onBusy: () => never
): Promise<T> {
  if (ownership.getStore()?.active) return mutate();
  if (!(await acquireLock(ENTITY_LIFECYCLE_LOCK))) return onBusy();
  const owner = { active: true };
  asyncOwner = true;
  try {
    return await ownership.run(owner, mutate);
  } finally {
    owner.active = false;
    asyncOwner = false;
    releaseLock(ENTITY_LIFECYCLE_LOCK);
  }
}
