import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { isValidTenantSlug } from './scope.js';

/** A server-created, deny-only ceiling. Never populate paths from client input. */
export interface ResourceAccessScope {
  readonly tenantSlug: string;
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

export type ResourceAccessOperation = 'read' | 'write' | 'append' | 'mkdir' | 'metadata';

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

function freezeScope(scope: ResourceAccessScope): ResourceAccessScope {
  if (
    !scope ||
    !isValidTenantSlug(scope.tenantSlug) ||
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
    tenantSlug: scope.tenantSlug,
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
        parent.tenantSlug !== frozen.tenantSlug ||
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
  if (
    (target !== '' && !validPath(target)) ||
    scopes.some((scope) => !permits(scope, target, operation))
  ) {
    return {
      allowed: false,
      reason: '[RESOURCE_SCOPE_DENIED] Resource operation is outside the request capability',
    };
  }
  return null;
}
