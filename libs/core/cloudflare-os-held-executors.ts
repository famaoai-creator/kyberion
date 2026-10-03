/**
 * Held-action executors and the params-at-rest rule.
 *
 * Executors are never persisted. They live in one process-level registry keyed
 * by op, shared by every control-plane instance in the process, so an approved
 * effect stays runnable after a journal catch-up replaces the record object or
 * the process restarts (the plane resolves one at apply time).
 */

export interface HeldExecutor {
  apply: (params: never, resolvedProvisionalRefs: Map<string, unknown>) => unknown;
  revert?: (result: never, previousState: unknown) => void | Promise<void>;
}

const heldExecutors = new Map<string, HeldExecutor>();

export function registerHeldExecutor(op: string, executor: HeldExecutor): void {
  heldExecutors.set(op, executor);
}

export function lookupHeldExecutor(op: string): HeldExecutor | undefined {
  return heldExecutors.get(op);
}

const SECRET_LIKE_KEY =
  /(secret|token|passw(or)?d|api[_-]?key|authorization|credential|private[_-]?key|bearer)/i;

/** Path of the first secret-like key in `value`, if any (bounded depth). */
function findSecretLikeKey(value: unknown, trail = 'params', depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 8) return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_KEY.test(key)) return `${trail}.${key}`;
    const nested = findSecretLikeKey(child, `${trail}.${key}`, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * `persistParams` writes params to the journal and snapshot in clear, so the
 * submitter must pass credentials by reference instead of embedding them.
 */
export function assertPersistableParams(params: unknown): void {
  const secretPath = findSecretLikeKey(params);
  if (secretPath) {
    throw new Error(
      `[POLICY_VIOLATION] persistParams requires params without secret-like keys (${secretPath}); pass credentials by reference`
    );
  }
}
