/**
 * Foundation-only Concierge management grant (G2 of the store-catalog guard design). Only the
 * governed facade surface/concierge-management-access.ts opens it (import boundary test
 * tests/concierge-management-capability-boundary.test.ts).
 *
 * The grant is module-private: its AsyncLocalStorage and issued set live in this module instance
 * only (no globalThis registry; scripts/check_core_single_instance.ts keeps a production process on
 * one @agent/core instance). It is bound to the execution scope it was opened in (the Concierge
 * management role assumption of its facade): a nested role assumption inside it sees no grant, as
 * the role-keyed checks it replaces no longer applied there.
 *
 * Lifetime equals the facade call: the synchronous form ends when its callback returns (a thenable
 * result is refused); the asynchronous form ends when the awaited body settles. Work scheduled
 * inside it that runs after it ended (a captured continuation) sees no grant.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { innermostExecutionScopeIdentity } from './execution-scope.js';

export type ConciergeManagementGrantKind = 'reader' | 'writer';

/**
 * Issuance rights of the grant. They are the Concierge-only role names of role-assumption-policy
 * `system_roles.concierge.may_assume`; the facade checks them with assertStoreGrantIssuanceAllowed.
 */
export const CONCIERGE_MANAGEMENT_ISSUANCE_RIGHTS: Readonly<
  Record<ConciergeManagementGrantKind, string>
> = Object.freeze({
  reader: 'concierge_management_reader',
  writer: 'concierge_management_writer',
});

type Grant = Readonly<{ kind: ConciergeManagementGrantKind; scope: object }>;
const storage = new AsyncLocalStorage<Grant>();
const issued = new WeakSet<Grant>();

function issue(kind: ConciergeManagementGrantKind): Grant {
  if (kind !== 'reader' && kind !== 'writer')
    throw new Error('[RESOURCE_SCOPE_REQUIRED] Unknown Concierge management grant kind');
  const scope = innermostExecutionScopeIdentity();
  if (!scope)
    throw new Error(
      '[RESOURCE_SCOPE_REQUIRED] A Concierge management grant needs its execution scope'
    );
  const grant: Grant = Object.freeze({ kind, scope });
  issued.add(grant);
  return grant;
}

function isThenable(value: unknown): boolean {
  return (
    Boolean(value) &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in (value as object)
  );
}

/** Synchronous grant: ends when `run` returns; a thenable result is refused. */
export function withConciergeManagementGrant<T>(
  kind: ConciergeManagementGrantKind,
  run: () => T
): T {
  const grant = issue(kind);
  try {
    return storage.run(grant, () => {
      const result = run();
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error(
          '[RESOURCE_SCOPE_REQUIRED] A synchronous Concierge management grant cannot span awaits'
        );
      }
      return result;
    });
  } finally {
    issued.delete(grant);
  }
}

/** Asynchronous grant: ends when the awaited body settles (fulfilled or rejected). */
export async function withConciergeManagementGrantAsync<T>(
  kind: ConciergeManagementGrantKind,
  run: () => Promise<T> | T
): Promise<T> {
  const grant = issue(kind);
  try {
    return await storage.run(grant, run);
  } finally {
    issued.delete(grant);
  }
}

/**
 * The live grant kind: issued, not yet ended, and opened in the current execution scope (a nested
 * role assumption or a scope opened after it ended sees none).
 */
export function conciergeManagementGrantKind(): ConciergeManagementGrantKind | undefined {
  const grant = storage.getStore();
  if (!grant || !issued.has(grant) || grant.scope !== innermostExecutionScopeIdentity())
    return undefined;
  return grant.kind;
}
