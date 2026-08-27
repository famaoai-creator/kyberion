import {
  collectOperatorHomeSummary,
  currentScope,
  pathResolver,
  type OperatorHomeScopeFilter,
  type OperatorHomeSummary,
  type ScopeContext,
} from '@agent/core';

export interface OperatorHomePacket {
  summary: OperatorHomeSummary;
  scope: ScopeContext;
}

/** Convert the authoritative runtime scope into read-only home-summary filters. */
export function operatorHomeScopeFilter(scope: ScopeContext): OperatorHomeScopeFilter {
  return {
    tiers: [scope.tier],
    ...(scope.tenant_slug
      ? { tenantSlugs: [scope.tenant_slug] }
      : scope.tier === 'public'
        ? { tenantSlugs: 'all' as const }
        : { tenantSlugs: [] }),
    ...(scope.organization_id ? { organizationIds: [scope.organization_id] } : {}),
    ...(scope.project_id ? { projectIds: [scope.project_id] } : {}),
  };
}

/** Read-only operator packet used by the conversation-first cockpit. */
export function loadOperatorHome(): OperatorHomePacket {
  const scope = currentScope();
  return {
    summary: collectOperatorHomeSummary({
      limit: 5,
      scope: operatorHomeScopeFilter(scope),
    }),
    scope,
  };
}

export function operatorHomeWatchPaths(): string[] {
  return [
    pathResolver.active('missions'),
    pathResolver.active('shared/runtime'),
    pathResolver.active('shared/coordination/channels'),
    pathResolver.shared('inbox/entries.jsonl'),
    pathResolver.active('shared/coordination/channels'),
    pathResolver.shared('inbox/entries.jsonl'),
  ];
}
