import * as path from 'node:path';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';

/** Physical tenant namespace root. The unqualified base path is the system namespace. */
export const PHYSICAL_TENANT_NAMESPACE = 'tenants';

export const PHYSICAL_SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function assertPhysicalScopeSegment(value: string, label: string): string {
  if (!PHYSICAL_SCOPE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`[PHYSICAL_NAMESPACE_SEGMENT_INVALID] ${label} '${value}'`);
  }
  return value;
}

/**
 * Return the entity path below a tenant without treating customer stance or
 * tier names as a physical tenant boundary.
 */
export function physicalScopeNamespace(scopeInput: EventScopeInput): string {
  const scope = normalizeEventScope(scopeInput);
  if (!scope.tenant_slug) return '';

  const segments = [
    PHYSICAL_TENANT_NAMESPACE,
    assertPhysicalScopeSegment(scope.tenant_slug, 'tenant_slug'),
  ];
  const entitySegments: Array<[keyof EventScope, string]> = [
    ['organization_id', 'organizations'],
    ['project_id', 'projects'],
    ['mission_id', 'missions'],
    ['task_id', 'tasks'],
    ['session_id', 'sessions'],
  ];
  for (const [key, directory] of entitySegments) {
    const value = scope[key];
    if (typeof value !== 'string' || !value) continue;
    segments.push(directory, assertPhysicalScopeSegment(value, key));
  }
  return segments.join('/');
}

/** Build a repo-relative physical path under a scope-specific namespace. */
export function physicalScopedPath(
  base: string,
  scope: EventScopeInput,
  ...parts: string[]
): string {
  const namespace = physicalScopeNamespace(scope);
  return path.posix.join(base, ...(namespace ? [namespace] : []), ...parts);
}

export function isTenantPhysicalNamespacePath(logicalPath: string): boolean {
  return logicalPath.split('/').includes(PHYSICAL_TENANT_NAMESPACE);
}
