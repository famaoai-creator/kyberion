import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * RA-01: the in-process execution scope set by `withExecutionContext` /
 * `withExecutionContextAsync` (authority.ts).
 *
 * The assumed role and persona live here rather than only in
 * `process.env.MISSION_ROLE` / `KYBERION_PERSONA` because
 *   - a surface launched by surface_runtime runs with `SYSTEM_ROLE`, which
 *     outranks `MISSION_ROLE`, so an env-only assumption was silently ignored;
 *   - mutating process-global env from an async helper races between
 *     concurrent requests served by one process.
 *
 * The scope is in-process only: it can never be inherited from a parent
 * process's environment. This leaf module has no imports beyond node core so
 * secure-io, the identity bridge and authority can all read it without an
 * import cycle. The storage is pinned on `globalThis` so that a second module
 * instance (source + dist registries in one process) still shares one scope.
 */
export interface ExecutionScope {
  tenantBound: boolean;
  tenantSlug?: string;
  /** Role assumed in-process by withExecutionContext*. */
  assumedRole?: string;
  /**
   * Persona bound with the assumed role. `null` means the assumption cleared
   * the persona; `undefined` means the assumption left it to the environment.
   */
  assumedPersona?: string | null;
}

const STORAGE_KEY = Symbol.for('kyberion.core.execution-scope');

type ScopeGlobal = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<ExecutionScope>;
};

const scopeGlobal = globalThis as ScopeGlobal;

export const executionScopeStorage: AsyncLocalStorage<ExecutionScope> =
  scopeGlobal[STORAGE_KEY] ?? (scopeGlobal[STORAGE_KEY] = new AsyncLocalStorage<ExecutionScope>());

export function currentExecutionScope(): ExecutionScope | undefined {
  return executionScopeStorage.getStore();
}

/** The role assumed by the innermost withExecutionContext*, if any. */
export function scopedAssumedRole(): string | undefined {
  const role = currentExecutionScope()?.assumedRole?.trim();
  return role ? role : undefined;
}

/**
 * The persona bound by the innermost withExecutionContext*.
 * `bound: false` means no assumption decided the persona, so callers fall back
 * to the `KYBERION_PERSONA` environment variable.
 */
export function scopedPersona(): { bound: boolean; persona?: string } {
  const scope = currentExecutionScope();
  if (!scope?.assumedRole || scope.assumedPersona === undefined) return { bound: false };
  return scope.assumedPersona === null
    ? { bound: true }
    : { bound: true, persona: scope.assumedPersona };
}
