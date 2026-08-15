import { assertScopeContext, type ScopeContext } from './scope-context.js';

export interface MemoryScopeEnvelope extends ScopeContext {
  owner_nhi?: string;
  retention_policy?: string;
  allowed_audience?: string[];
  promotion_policy?: 'same_scope' | 'brokered' | 'human_review';
  provenance_refs?: string[];
  redacted?: boolean;
}

const TIER_RANK: Record<ScopeContext['tier'], number> = {
  public: 0,
  confidential: 1,
  personal: 2,
};

const principalFor = (context: ScopeContext): string[] =>
  [context.viewer_principal, context.nhi_id].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );

export function assertMemoryScope(
  scope: MemoryScopeEnvelope,
  tier: ScopeContext['tier'] = scope.tier
): MemoryScopeEnvelope {
  const normalized = assertScopeContext(
    { ...scope, tier },
    { requireTenant: tier === 'confidential' }
  );
  if (scope.allowed_audience?.some((entry) => !entry.trim())) {
    throw new Error('[MEMORY_SCOPE_INVALID] allowed_audience contains an empty principal');
  }
  if (scope.provenance_refs?.some((entry) => !entry.trim())) {
    throw new Error('[MEMORY_SCOPE_INVALID] provenance_refs contains an empty reference');
  }
  if (scope.promotion_policy === 'brokered' && !scope.owner_nhi?.trim()) {
    throw new Error('[MEMORY_SCOPE_INVALID] brokered memory requires owner_nhi');
  }
  return {
    ...normalized,
    ...(scope.owner_nhi?.trim() ? { owner_nhi: scope.owner_nhi.trim() } : {}),
    ...(scope.retention_policy?.trim() ? { retention_policy: scope.retention_policy.trim() } : {}),
    ...(scope.allowed_audience
      ? { allowed_audience: scope.allowed_audience.map((entry) => entry.trim()) }
      : {}),
    ...(scope.promotion_policy ? { promotion_policy: scope.promotion_policy } : {}),
    ...(scope.provenance_refs
      ? { provenance_refs: scope.provenance_refs.map((entry) => entry.trim()) }
      : {}),
    ...(scope.redacted !== undefined ? { redacted: scope.redacted } : {}),
    tier,
  };
}

export function memoryScopeAllowsRead(source: MemoryScopeEnvelope, viewer: ScopeContext): boolean {
  try {
    const normalizedSource = assertMemoryScope(source, source.tier);
    const normalizedViewer = assertScopeContext(viewer, { requireTenant: false });
    if (TIER_RANK[normalizedViewer.tier] < TIER_RANK[normalizedSource.tier]) return false;

    const audience = normalizedSource.allowed_audience || [];
    if (
      audience.length > 0 &&
      !principalFor(normalizedViewer).some((principal) => audience.includes(principal))
    ) {
      return false;
    }

    if (normalizedSource.tier === 'personal') {
      if (
        normalizedSource.owner_nhi &&
        !principalFor(normalizedViewer).includes(normalizedSource.owner_nhi) &&
        audience.length === 0
      ) {
        return false;
      }
      if (!normalizedSource.owner_nhi && audience.length === 0) return false;
    }

    if (normalizedSource.tier !== 'public') {
      if (
        normalizedSource.tenant_slug &&
        normalizedSource.tenant_slug !== normalizedViewer.tenant_slug
      ) {
        return false;
      }
      if (
        normalizedSource.organization_id &&
        normalizedSource.organization_id !== normalizedViewer.organization_id
      ) {
        return false;
      }
      if (
        normalizedSource.project_id &&
        normalizedSource.project_id !== normalizedViewer.project_id
      ) {
        return false;
      }
      if (
        normalizedSource.mission_id &&
        normalizedSource.mission_id !== normalizedViewer.mission_id
      ) {
        return false;
      }
      if (normalizedSource.task_id && normalizedSource.task_id !== normalizedViewer.task_id) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
