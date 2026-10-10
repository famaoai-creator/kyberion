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
  readonly mkdirExact: readonly string[];
  readonly allowProductKnowledgeRead?: boolean;
}

export type ResourceAccessOperation = 'read' | 'write' | 'mkdir' | 'metadata';

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
  return Object.freeze({
    tenantSlug: scope.tenantSlug,
    ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    metadataExact: copy(scope.metadataExact ?? []),
    readExact: copy(scope.readExact),
    writeExact: copy(scope.writeExact),
    mkdirExact: copy(scope.mkdirExact),
    allowProductKnowledgeRead: scope.allowProductKnowledgeRead === true,
  });
}

/** Independent of role scopes: nested role assumptions cannot discard this ceiling. */
export function runInResourceAccessScope<T>(scope: ResourceAccessScope, fn: () => T): T {
  const frozen = freezeScope(scope);
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

function permits(
  scope: ResourceAccessScope,
  target: string,
  operation: ResourceAccessOperation
): boolean {
  if (operation === 'read') {
    return (
      scope.readExact.includes(target) ||
      (scope.allowProductKnowledgeRead === true && target.startsWith('knowledge/product/'))
    );
  }
  if (operation === 'write') return scope.writeExact.includes(target);
  if (operation === 'mkdir') return scope.mkdirExact.includes(target);
  // Metadata inspection permits traversal, never directory enumeration or file content.
  return (
    [
      ...(scope.metadataExact ?? []),
      ...scope.readExact,
      ...scope.writeExact,
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
