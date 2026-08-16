import * as path from 'node:path';
import type { ScopeContext } from './scope-context.js';
import { assertScopeContext, scopeContextKey } from './scope-context.js';
import { isValidTenantSlug } from './entity-scope.js';

/**
 * Positive knowledge roots derived from the canonical containment chain.
 * A reader may only scan one of these roots; there is no blocklist fallback.
 */
export interface KnowledgeScopeSet {
  scope: ScopeContext;
  roots: string[];
  systemAuthority: boolean;
}

function cleanSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) return undefined;
  return normalized;
}

function entityRoot(scope: ScopeContext, root: 'confidential' | 'personal'): string | undefined {
  const tenant = cleanSegment(scope.tenant_slug);
  if (!tenant) return undefined;
  const segments = [root, tenant];
  const entities: Array<[keyof ScopeContext, string]> = [
    ['organization_id', 'organizations'],
    ['project_id', 'projects'],
    ['mission_id', 'missions'],
    ['task_id', 'tasks'],
    ['session_id', 'sessions'],
  ];
  for (const [key, directory] of entities) {
    const value = cleanSegment(scope[key]);
    if (!value) break;
    segments.push(directory, value);
  }
  return segments.join('/');
}

/** Build a write target from the canonical containment chain. */
export function knowledgeWritePathFor(
  scopeInput: ScopeContext,
  level:
    | 'tenant'
    | 'organization'
    | 'project'
    | 'mission'
    | 'task'
    | 'session'
    | 'common'
    | 'product'
    | 'public',
  slug: string,
  extension = '.md'
): string {
  const scope = assertScopeContext(scopeInput, { requireTenant: false, allowShared: true });
  const name = slug
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) throw new Error('[KNOWLEDGE_WRITE_INVALID] slug is required');
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  if (level === 'product') return path.posix.join('product', `${name}${suffix}`);
  if (level === 'public') return path.posix.join('public', `${name}${suffix}`);
  if (level === 'common') {
    if (scope.tier !== 'confidential') {
      throw new Error('[KNOWLEDGE_WRITE_INVALID] common knowledge requires confidential tier');
    }
    return path.posix.join('confidential', 'common', `${name}${suffix}`);
  }
  if (!scope.tenant_slug || !isValidTenantSlug(scope.tenant_slug)) {
    throw new Error('[SCOPE_CONTEXT_INVALID] tenant_slug is required for scoped knowledge');
  }
  if (scope.tier === 'public') {
    throw new Error(
      '[KNOWLEDGE_WRITE_INVALID] tenant-scoped knowledge requires personal or confidential tier'
    );
  }
  const selected: Record<typeof level, string | undefined> = {
    tenant: scope.tenant_slug,
    organization: scope.organization_id,
    project: scope.project_id,
    mission: scope.mission_id,
    task: scope.task_id,
    session: scope.session_id,
  };
  const required = selected[level];
  if (!required)
    throw new Error(`[KNOWLEDGE_WRITE_INVALID] ${level} is absent from the scope chain`);
  const chain: Array<[string, string | undefined]> = [
    ['organizations', scope.organization_id],
    ['projects', scope.project_id],
    ['missions', scope.mission_id],
    ['tasks', scope.task_id],
    ['sessions', scope.session_id],
  ];
  const parts = [scope.tier === 'personal' ? 'personal' : 'confidential', scope.tenant_slug];
  for (const [directory, value] of chain) {
    if (!value) break;
    parts.push(directory, value);
    if (value === required) break;
  }
  return path.posix.join(...parts, `${name}${suffix}`);
}

/** Resolve the only knowledge subtrees a scope is allowed to read. */
export function resolveKnowledgeScopeSet(
  scopeInput: ScopeContext,
  options: { includeCommon?: boolean; systemAuthority?: boolean } = {}
): KnowledgeScopeSet {
  const scope = assertScopeContext(scopeInput, { requireTenant: false, allowShared: true });
  const roots = ['public', 'product'];
  const systemAuthority = options.systemAuthority === true;

  // Tier is an authorization dimension, not merely a hint.  A tenant-aware
  // public request must not gain confidential access just because it carries a
  // tenant for routing or telemetry.
  if (scope.tier === 'confidential') {
    const confidentialRoot = entityRoot(scope, 'confidential');
    if (confidentialRoot) roots.push(confidentialRoot);
    if (options.includeCommon !== false) roots.push('confidential/common');
  }
  if (scope.tier === 'personal' && scope.tenant_slug) {
    const personalRoot = entityRoot(scope, 'personal');
    if (personalRoot) roots.push(personalRoot);
  }
  if (systemAuthority) {
    roots.push('confidential');
    if (scope.tier === 'personal') roots.push('personal');
  }

  return { scope, roots: [...new Set(roots)], systemAuthority };
}

/** Return true only when a knowledge-relative path is inside an allowed root. */
export function assertKnowledgePathInScope(
  relativePath: string,
  scopeSet: KnowledgeScopeSet
): boolean {
  const raw = relativePath.replace(/\\/g, '/');
  if (raw.split('/').some((segment) => segment === '..')) return false;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    return false;
  }
  return scopeSet.roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function knowledgeScopeContextKey(scope: ScopeContext): string {
  return scopeContextKey(assertScopeContext(scope, { requireTenant: false, allowShared: true }));
}

export function knowledgeRootsForTiers(
  scope: ScopeContext,
  tiers: readonly string[],
  options: { customerId?: string; systemAuthority?: boolean } = {}
): KnowledgeScopeSet {
  const requested = new Set(tiers);
  const effective: ScopeContext = {
    ...scope,
    ...(options.customerId && !scope.tenant_slug ? { tenant_slug: options.customerId } : {}),
  };
  const resolved = resolveKnowledgeScopeSet(effective, options);
  return {
    ...resolved,
    roots: resolved.roots.filter((root) => {
      if (root === 'public') return requested.has('public');
      if (root === 'product') return requested.has('product');
      if (root.startsWith('personal')) return requested.has('personal');
      if (root.startsWith('confidential')) return requested.has('confidential');
      return false;
    }),
  };
}
