import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { isValidMemberId, isValidTenantSlug } from './scope.js';

/**
 * The custodian a request ceiling binds (G4 of the store-catalog guard design):
 * `tenant` — one tenant's material; `system` — installation-level material with
 * no tenant; `person` — personal material of one member (`ref` omitted binds
 * the installation's person scope, mirroring custody-owner's optional
 * principal). A scope names whose ceiling it is; the declaration alone confers
 * nothing — it only ever narrows.
 */
export type ResourceAccessCustody =
  | { readonly kind: 'system' }
  | { readonly kind: 'tenant' }
  | { readonly kind: 'person'; readonly ref?: string };

/** A server-created, deny-only ceiling. Never populate paths from client input. */
export interface ResourceAccessScope {
  /**
   * Custodian of this ceiling. Omitted means tenant custody (backwards
   * compatible); `freezeScope` normalizes it so a frozen scope always carries
   * one. Non-tenant custody must not name a tenant, organization or project.
   */
  readonly custody?: ResourceAccessCustody;
  /** The bound tenant slug; required and present only for tenant custody. */
  readonly tenantSlug?: string;
  /** Tenant-context bindings; valid only with tenant custody. */
  readonly organizationId?: string;
  readonly projectId?: string;
  /** Metadata only: no file contents, directory listing, or mutation. */
  readonly metadataExact?: readonly string[];
  readonly readExact: readonly string[];
  readonly writeExact: readonly string[];
  /** Append-only access grants neither ordinary writes nor file descriptor access. */
  readonly appendExact?: readonly string[];
  readonly mkdirExact: readonly string[];
  /**
   * Read/write/append/metadata of paths that complete one of these exact
   * prefixes with a single path component (no further `/`; never mkdir), for
   * stores whose maintenance names its own siblings at run time (e.g.
   * `<store>.compacting-`, `<store dir>/compaction-archive/`).
   */
  readonly namePrefixExact?: readonly string[];
  readonly allowProductKnowledgeRead?: boolean;
  /** Internal opaque identity only; possession alone grants nothing. Store guards verify it. */
  readonly opaqueStoreToken?: object;
}

const RESOURCE_ACCESS_OPERATIONS = ['read', 'write', 'append', 'mkdir', 'metadata'] as const;
export type ResourceAccessOperation = (typeof RESOURCE_ACCESS_OPERATIONS)[number];

export type ResourceAccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'invalid_operation' | 'invalid_path' | 'outside_scope';
    };

const KEY = Symbol.for('kyberion.core.resource-access-scope.v1');
type Registry = { storage: AsyncLocalStorage<readonly ResourceAccessScope[]> };
const globalRegistry = globalThis as typeof globalThis & { [KEY]?: Registry };
const registry =
  globalRegistry[KEY] ?? (globalRegistry[KEY] = { storage: new AsyncLocalStorage() });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.includes(':') &&
    !value.includes('*') &&
    !value.includes('$') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('../') &&
    !value.endsWith('/')
  );
}

/** A prefix is canonical when it is a valid path plus an optional trailing `/`, below a directory. */
function validNamePrefix(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const stem = value.endsWith('/') ? value.slice(0, -1) : value;
  return validPath(stem) && stem.includes('/');
}

/** Does `target` complete one of the scope's name prefixes with a single path component? */
export function matchesNamePrefix(scope: ResourceAccessScope, target: string): boolean {
  return (scope.namePrefixExact ?? []).some(
    (prefix) =>
      target.length > prefix.length &&
      target.startsWith(prefix) &&
      !target.slice(prefix.length).includes('/')
  );
}

/** Custody normalization — a malformed declaration fails closed. */
function freezeCustody(scope: ResourceAccessScope): ResourceAccessCustody {
  const custody = scope.custody;
  if (custody !== undefined && custody !== null) {
    if (typeof custody !== 'object' || !['system', 'tenant', 'person'].includes(custody.kind))
      throw new Error('[RESOURCE_SCOPE_INVALID] Unknown custody kind');
    if (custody.kind !== 'tenant') {
      if (
        scope.tenantSlug !== undefined ||
        scope.organizationId !== undefined ||
        scope.projectId !== undefined
      )
        throw new Error(
          '[RESOURCE_SCOPE_INVALID] Non-tenant custody cannot bind a tenant, organization or project'
        );
      if (custody.kind === 'person') {
        if (
          custody.ref !== undefined &&
          (typeof custody.ref !== 'string' || !isValidMemberId(custody.ref))
        )
          throw new Error('[RESOURCE_SCOPE_INVALID] Invalid person custody ref');
        return Object.freeze(
          custody.ref === undefined
            ? { kind: 'person' as const }
            : { kind: 'person' as const, ref: custody.ref }
        );
      }
      return Object.freeze({ kind: 'system' as const });
    }
  }
  if (!isValidTenantSlug(scope.tenantSlug ?? ''))
    throw new Error('[RESOURCE_SCOPE_INVALID] Missing or invalid resource binding');
  return Object.freeze({ kind: 'tenant' as const });
}

/** Two frozen scopes nest only when they bind the same custodian. */
function sameCustody(left: ResourceAccessScope, right: ResourceAccessScope): boolean {
  const lc = left.custody ?? { kind: 'tenant' as const };
  const rc = right.custody ?? { kind: 'tenant' as const };
  if (lc.kind !== rc.kind) return false;
  if (lc.kind === 'tenant') return left.tenantSlug === right.tenantSlug;
  if (lc.kind === 'person' && rc.kind === 'person') return lc.ref === rc.ref;
  return true;
}

function freezeScope(scope: ResourceAccessScope): ResourceAccessScope {
  if (!scope) throw new Error('[RESOURCE_SCOPE_INVALID] Missing or invalid resource binding');
  const custody = freezeCustody(scope);
  if (
    (scope.organizationId !== undefined && !ID.test(scope.organizationId)) ||
    (scope.projectId !== undefined && (!scope.organizationId || !ID.test(scope.projectId))) ||
    (scope.allowProductKnowledgeRead !== undefined &&
      typeof scope.allowProductKnowledgeRead !== 'boolean')
  ) {
    throw new Error('[RESOURCE_SCOPE_INVALID] Missing or invalid resource binding');
  }
  const copy = (values: readonly string[]): readonly string[] => {
    if (!Array.isArray(values) || !values.every(validPath)) {
      throw new Error(
        '[RESOURCE_SCOPE_INVALID] Expected canonical repository-relative exact paths'
      );
    }
    return Object.freeze([...new Set(values)]);
  };
  const result: ResourceAccessScope = {
    custody,
    ...(scope.tenantSlug ? { tenantSlug: scope.tenantSlug } : {}),
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    metadataExact: copy(scope.metadataExact ?? []),
    readExact: copy(scope.readExact),
    writeExact: copy(scope.writeExact),
    appendExact: copy(scope.appendExact ?? []),
    mkdirExact: copy(scope.mkdirExact),
    namePrefixExact: (() => {
      const values = scope.namePrefixExact ?? [];
      if (!Array.isArray(values) || !values.every(validNamePrefix))
        throw new Error('[RESOURCE_SCOPE_INVALID] Expected canonical repository-relative prefixes');
      return Object.freeze([...new Set(values)]);
    })(),
    allowProductKnowledgeRead: scope.allowProductKnowledgeRead === true,
  };
  if (scope.opaqueStoreToken !== undefined)
    Object.defineProperty(result, 'opaqueStoreToken', { value: scope.opaqueStoreToken });
  return Object.freeze(result);
}

/** Independent of role scopes: nested role assumptions cannot discard this ceiling. */
export function runInResourceAccessScope<T>(scope: ResourceAccessScope, fn: () => T): T {
  return runInFrozenResourceAccessScope(freezeScope(scope), fn);
}

function runInFrozenResourceAccessScope<T>(frozen: ResourceAccessScope, fn: () => T): T {
  const outer = registry.storage.getStore() ?? [];
  if (
    outer.some(
      (parent) =>
        !sameCustody(parent, frozen) ||
        (parent.organizationId && parent.organizationId !== frozen.organizationId) ||
        (parent.projectId && parent.projectId !== frozen.projectId)
    )
  ) {
    throw new Error('[RESOURCE_SCOPE_INVALID] Nested resource bindings cannot change');
  }
  return registry.storage.run(Object.freeze([...outer, frozen]), fn);
}

export function currentResourceAccessScope(): ResourceAccessScope | undefined {
  return registry.storage.getStore()?.at(-1);
}

/**
 * S4 (scope model P4): run the audit chain's own system-scope record of a store
 * grant disclosure outside every request ceiling. The record holds no tenant
 * content (grant name, principal, bound scope, operation), and audit
 * persistence writes it as the chain's own store writer, never as the caller,
 * so leaving the ceiling grants the caller nothing: it only lets the
 * disclosure's record land (fail closed) even when the caller is already inside
 * an exact ceiling. The ceilings are restored when `fn` returns. Callable only
 * from authority.ts's disclosure writer (tests/resource-ceiling-audit-exit-boundary.test.ts);
 * `fn` must run only canonical audit code, never a caller callback.
 */
export function runDisclosureAuditOutsideResourceCeilings<T>(fn: () => T): T {
  return registry.storage.exit(fn);
}

export interface SynchronousResourceGrantIssuer<Binding> {
  /** The domain facade validates and freezes its binding before calling this. No role is assumed. */
  run<T>(binding: Readonly<Binding>, scope: ResourceAccessScope, action: () => T): T;
  /** Only this issuer's live, exact frozen ceiling resolves. A matching label is not proof. */
  resolve(
    scope: ResourceAccessScope | undefined
  ): Readonly<{ binding: Readonly<Binding>; scope: ResourceAccessScope }> | undefined;
}

/**
 * Shared opaque-grant lifetime, not an authorization facade. Keep the issuer
 * instance private to the domain's existing governed issuer. The diagnostic
 * prefix never identifies or authenticates an issuer; each factory call owns
 * its own token registry. This adds no catalog/identity I/O to foundation.
 */
export function createSynchronousResourceGrantIssuer<Binding>(
  errorPrefix = 'RESOURCE_GRANT'
): SynchronousResourceGrantIssuer<Binding> {
  const active = new WeakMap<
    object,
    Readonly<{ binding: Readonly<Binding>; scope: ResourceAccessScope }>
  >();
  return Object.freeze({
    run<T>(binding: Readonly<Binding>, scope: ResourceAccessScope, action: () => T): T {
      if (Object.hasOwn(scope, 'opaqueStoreToken'))
        throw new Error(`[${errorPrefix}_INVALID] Only the issuer may attach a token`);
      const token = Object.freeze({});
      const frozen = freezeScope({ ...scope, opaqueStoreToken: token });
      active.set(token, Object.freeze({ binding, scope: frozen }));
      try {
        return runInFrozenResourceAccessScope(frozen, () => {
          const result = action();
          if (
            result &&
            (typeof result === 'object' || typeof result === 'function') &&
            'then' in result
          ) {
            // Assimilation handles rejected Promises/thenables without leaking an
            // unhandled rejection. finally revokes before queued work can run.
            void Promise.resolve(result).catch(() => undefined);
            throw new Error(`[${errorPrefix}_ASYNC] Storage grant is synchronous only`);
          }
          const seen = new WeakSet<object>();
          const escapes = (value: unknown): boolean => {
            if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
            if (active.has(value) || Object.hasOwn(value, 'opaqueStoreToken')) return true;
            if (seen.has(value)) return false;
            seen.add(value);
            if (
              value instanceof Map &&
              [...Map.prototype.entries.call(value)].some(
                ([key, entry]) => escapes(key) || escapes(entry)
              )
            )
              return true;
            if (value instanceof Set && [...Set.prototype.values.call(value)].some(escapes))
              return true;
            // Never execute accessors while inspecting a result. Any closure or
            // accessor that retained a token still loses it in finally.
            return Reflect.ownKeys(value).some((key) => {
              const descriptor = Object.getOwnPropertyDescriptor(value, key);
              return descriptor !== undefined && 'value' in descriptor && escapes(descriptor.value);
            });
          };
          if (escapes(result))
            throw new Error(`[${errorPrefix}_ESCAPE] Internal grant material cannot be returned`);
          return result;
        });
      } finally {
        active.delete(token);
      }
    },
    resolve(scope: ResourceAccessScope | undefined) {
      const record = scope?.opaqueStoreToken ? active.get(scope.opaqueStoreToken) : undefined;
      return record?.scope === scope && scope === currentResourceAccessScope() ? record : undefined;
    },
  });
}

/**
 * Pure operation ceiling over a server-validated scope. This neither authenticates
 * a grant nor checks roles, tenant ownership or other enclosing scopes.
 */
export function decideResourceAccess(
  scope: ResourceAccessScope,
  target: string,
  operation: ResourceAccessOperation
): ResourceAccessDecision {
  // Runtime input must fail closed before name-prefix or metadata matching.
  if (!RESOURCE_ACCESS_OPERATIONS.includes(operation))
    return { allowed: false, reason: 'invalid_operation' };
  if ((target !== '' || operation !== 'metadata') && !validPath(target))
    return { allowed: false, reason: 'invalid_path' };
  return permits(scope, target, operation)
    ? { allowed: true }
    : { allowed: false, reason: 'outside_scope' };
}

function permits(
  scope: ResourceAccessScope,
  target: string,
  operation: ResourceAccessOperation
): boolean {
  if (operation !== 'mkdir' && matchesNamePrefix(scope, target)) return true;
  if (operation === 'read') {
    return (
      scope.readExact.includes(target) ||
      (scope.allowProductKnowledgeRead === true && target.startsWith('knowledge/product/'))
    );
  }
  if (operation === 'write') return scope.writeExact.includes(target);
  if (operation === 'append')
    return scope.writeExact.includes(target) || (scope.appendExact ?? []).includes(target);
  if (operation === 'mkdir') return scope.mkdirExact.includes(target);
  if (operation !== 'metadata') return false;
  // Metadata inspection permits traversal, never directory enumeration or file content.
  return (
    [
      ...(scope.metadataExact ?? []),
      ...scope.readExact,
      ...scope.writeExact,
      ...(scope.appendExact ?? []),
      ...scope.mkdirExact,
    ].some((allowed) => target === allowed || target === '' || allowed.startsWith(target + '/')) ||
    (scope.allowProductKnowledgeRead === true &&
      (target === 'knowledge' ||
        target === 'knowledge/product' ||
        target.startsWith('knowledge/product/')))
  );
}

/** Null means no scoped denial; ordinary policy checks must still run. */
export function resourceAccessDenial(
  target: string,
  operation: ResourceAccessOperation
): { allowed: false; reason: string } | null {
  const scopes = registry.storage.getStore();
  if (!scopes) return null;
  if (scopes.some((scope) => !decideResourceAccess(scope, target, operation).allowed)) {
    return {
      allowed: false,
      reason: '[RESOURCE_SCOPE_DENIED] Resource operation is outside the request capability',
    };
  }
  return null;
}
