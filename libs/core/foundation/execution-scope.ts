import { AsyncLocalStorage } from 'node:async_hooks';
import { getRegisteredEnvText } from './env.js';

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
 * process's environment. This foundation module imports nothing but node core
 * and the env accessor, so secure-io, the identity bridge and authority can all
 * read it without an import cycle. The storage is pinned on `globalThis` so a
 * second module instance (a bundled copy next to the external dist copy, as in
 * the Next.js surfaces) still shares one scope.
 *
 * S1: because the store is reachable through `globalThis`, the readers below
 * never trust a scope blindly. Every assumed role is re-checked at read time
 * against the validator authority.ts registers (the RA-02 role assumption
 * policy); a rejected role is ignored with a warning, so running a scope
 * directly on the storage cannot bypass the policy. Scopes are frozen, and
 * the only writer exported here is {@link runInExecutionScope}, owned by
 * authority.ts.
 */
export interface ExecutionScope {
  readonly tenantBound: boolean;
  readonly tenantSlug?: string;
  /** Role assumed in-process by withExecutionContext* (already normalized). */
  readonly assumedRole?: string;
  /**
   * Persona bound with the assumed role. `null` means the assumption cleared
   * the persona; `undefined` means the assumption left it to the environment.
   */
  readonly assumedPersona?: string | null;
}

/** Returns false when the current process may not act as `role` (RA-02). */
export type AssumedRoleValidator = (role: string) => boolean;

interface ScopeRegistry {
  readonly storage: AsyncLocalStorage<ExecutionScope>;
  validator?: AssumedRoleValidator;
}

const REGISTRY_KEY = Symbol.for('kyberion.core.execution-scope.v1');

type ScopeGlobal = typeof globalThis & { [REGISTRY_KEY]?: ScopeRegistry };

const scopeGlobal = globalThis as ScopeGlobal;

const registry: ScopeRegistry =
  scopeGlobal[REGISTRY_KEY] ??
  (scopeGlobal[REGISTRY_KEY] = { storage: new AsyncLocalStorage<ExecutionScope>() });

const warnedRejectedRoles = new Set<string>();

/**
 * Install the RA-02 validator (authority.ts). Every authority instance
 * registers the same policy check, so the latest registration wins; that keeps
 * a re-evaluated module (tests resetting modules, dev reloads) from being
 * judged by a stale instance's cache.
 */
export function registerAssumedRoleValidator(validator: AssumedRoleValidator): void {
  registry.validator = validator;
}

/** Run `fn` inside a frozen copy of `scope`. Only authority.ts should call this. */
export function runInExecutionScope<T>(scope: ExecutionScope, fn: () => T): T {
  return registry.storage.run(Object.freeze({ ...scope }), fn);
}

function isAcceptedRole(role: string): boolean {
  const validator = registry.validator;
  if (validator) return validator(role);
  // Before authority.ts registered its validator the policy cannot be
  // consulted: fail closed only where RA-02 applies (a SYSTEM_ROLE process).
  const systemRole = getRegisteredEnvText('SYSTEM_ROLE')?.trim();
  return !systemRole || systemRole.toLowerCase() === role;
}

/**
 * The innermost scope. Its `assumedRole` / `assumedPersona` are removed when
 * the role fails the read-time policy check, so callers can use the fields
 * directly.
 */
export function currentExecutionScope(): ExecutionScope | undefined {
  const scope = registry.storage.getStore();
  const role = scope?.assumedRole?.trim();
  if (!scope || !role) return scope;
  if (isAcceptedRole(role)) return scope;
  if (!warnedRejectedRoles.has(role)) {
    warnedRejectedRoles.add(role);
    console.warn(
      `[ROLE_ASSUMPTION_IGNORED] an execution scope carries role '${role}', which this process may not assume; it is ignored.`
    );
  }
  return Object.freeze({
    tenantBound: scope.tenantBound,
    ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
  });
}

/** The role assumed by the innermost withExecutionContext*, if any (policy-checked). */
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

/**
 * The persona of the current execution (B2): the persona bound by the
 * innermost withExecutionContext* when it decided one, else
 * `KYBERION_PERSONA`. Authorization inputs (policy-engine agentId, persona
 * gates) must use this rather than the raw env var, which the async helper
 * never mirrors and which is shared by every async context in the process.
 */
export function executionPersonaText(): string | undefined {
  const scoped = scopedPersona();
  return scoped.bound ? scoped.persona : getRegisteredEnvText('KYBERION_PERSONA');
}
