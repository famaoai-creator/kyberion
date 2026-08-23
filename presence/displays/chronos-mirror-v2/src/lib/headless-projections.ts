import {
  buildAgentCollaborationProjection,
  collectOperatorHomeSummary,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  type EventScopeKind,
  type WorkItemStatus,
} from '@agent/core';
import type { OperatorHomeScopeFilter } from '@agent/core/operator-home-summary';
import {
  buildWorkVisibilityProjection,
  type WorkVisibilityScope,
  type WorkVisibilityView,
} from '@agent/core/work-visibility';
import type { ViewerContext } from './viewer-context';
import {
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  strictViewerScopeTenantSlugs,
  withViewerExecutionContext,
} from './viewer-context';

export const HEADLESS_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
];

export class HeadlessQueryError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'HeadlessQueryError';
  }
}

export interface HeadlessScopeQuery {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}

export function headlessViewerScope(viewer: ViewerContext) {
  return {
    role: viewer.role,
    ...(viewer.principalId ? { principal_id: viewer.principalId } : {}),
    tenant_slugs: viewer.tenantSlugs,
    organization_ids: viewer.organizationIds ?? 'all',
    project_ids: viewer.projectIds ?? 'all',
    tier_access: viewer.tierAccess ?? [],
  } as const;
}

function resolveScope(viewer: ViewerContext, query: HeadlessScopeQuery) {
  return {
    tenantSlugs: strictViewerScopeTenantSlugs(viewer, query.tenant),
    organizationIds: strictViewerScopeOrganizationIds(viewer, query.organizationId),
    projectIds: strictViewerScopeProjectIds(viewer, query.projectId),
  };
}

export function readHeadlessOperatorHome(
  viewer: ViewerContext,
  query: HeadlessScopeQuery & { limit?: number; since?: string }
) {
  const scope = resolveScope(viewer, query);
  const summaryScope: OperatorHomeScopeFilter = {
    tiers: (viewer.tierAccess ?? []) as OperatorHomeScopeFilter['tiers'],
    tenantSlugs: scope.tenantSlugs,
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
  };
  return withViewerExecutionContext(viewer, () =>
    collectOperatorHomeSummary({
      budgetUsd: undefined,
      since: query.since,
      limit: query.limit,
      scope: summaryScope,
    })
  );
}

export function readHeadlessWorkItems(
  viewer: ViewerContext,
  query: HeadlessScopeQuery & {
    scope?: string;
    view?: string;
    missionId?: string;
  }
) {
  const scopeValue = query.scope || 'work_items';
  const allowedScopes: readonly WorkVisibilityScope[] = [
    'organization',
    'home',
    'work_items',
    'operations',
    'missions',
    'governance',
  ];
  if (!allowedScopes.includes(scopeValue as WorkVisibilityScope)) {
    throw new HeadlessQueryError(`invalid work-items scope: ${scopeValue}`);
  }
  const scope = scopeValue as WorkVisibilityScope;
  const viewValue = query.view || 'all';
  const allowedViews: readonly WorkVisibilityView[] = ['all', 'actionable', 'active', 'history'];
  if (!allowedViews.includes(viewValue as WorkVisibilityView)) {
    throw new HeadlessQueryError(`invalid work-items view: ${viewValue}`);
  }
  const view = viewValue as WorkVisibilityView;
  const resolved = resolveScope(viewer, query);
  const items = withViewerExecutionContext(viewer, () =>
    listWorkItems({
      tenantSlugs: resolved.tenantSlugs === 'all' ? undefined : resolved.tenantSlugs,
      organizationIds: resolved.organizationIds === 'all' ? undefined : resolved.organizationIds,
      projectIds: resolved.projectIds === 'all' ? undefined : resolved.projectIds,
    })
  );
  return buildWorkVisibilityProjection({
    items,
    viewer: {
      tenantSlugs: resolved.tenantSlugs,
      organizationIds: resolved.organizationIds,
      projectIds: resolved.projectIds,
    },
    scope,
    view,
    organizationId: query.organizationId,
    missionId: query.missionId,
    projectId: query.projectId,
  });
}

export function readHeadlessCollaboration(
  viewer: ViewerContext,
  query: HeadlessScopeQuery & {
    missionId?: string;
    limit?: number;
    scopeKind?: string;
    organizationId?: string;
    projectId?: string;
    taskId?: string;
    sessionId?: string;
  }
) {
  const resolved = resolveScope(viewer, query);
  const allowedScopeKinds = new Set([
    'system',
    'tenant',
    'organization',
    'project',
    'mission',
    'task',
    'session',
  ]);
  if (query.scopeKind && !allowedScopeKinds.has(query.scopeKind)) {
    throw new HeadlessQueryError(`invalid collaboration scope_kind: ${query.scopeKind}`);
  }
  const scopeFilter = {
    ...(query.organizationId ? { organization_id: query.organizationId } : {}),
    ...(query.projectId ? { project_id: query.projectId } : {}),
    ...(query.taskId ? { task_id: query.taskId } : {}),
    ...(query.sessionId ? { session_id: query.sessionId } : {}),
    ...(query.scopeKind ? { scope_kind: query.scopeKind as EventScopeKind } : {}),
  };
  return buildAgentCollaborationProjection({
    missionId: query.missionId,
    tenant:
      resolved.tenantSlugs === 'all' || resolved.tenantSlugs.length !== 1
        ? undefined
        : resolved.tenantSlugs[0],
    tenantSlugs: resolved.tenantSlugs,
    scopeFilter,
    limit: query.limit,
  });
}

export function updateHeadlessWorkItemStatus(
  viewer: ViewerContext,
  input: { itemId?: unknown; status?: unknown }
) {
  const itemId = typeof input.itemId === 'string' ? input.itemId.trim() : '';
  const status = HEADLESS_WORK_ITEM_STATUSES.includes(input.status as WorkItemStatus)
    ? (input.status as WorkItemStatus)
    : null;
  if (!itemId || !status) throw new Error('item_id and status are required');

  const current = withViewerExecutionContext(viewer, () => getWorkItem(itemId));
  if (!current) throw new Error('work item not found');

  const currentTenant =
    current.context?.tenant_slug ||
    (typeof current.metadata?.tenant_slug === 'string' ? current.metadata.tenant_slug : undefined);
  const currentOrganization =
    current.context?.organization_id ||
    (typeof current.metadata?.organization_id === 'string'
      ? current.metadata.organization_id
      : undefined);
  const currentProject = current.context?.project_id || current.project_id;
  const tenantSlugs = strictViewerScopeTenantSlugs(viewer);
  if (tenantSlugs !== 'all' && (!currentTenant || !tenantSlugs.includes(currentTenant))) {
    throw new Error('viewer is not authorized for this work item tenant');
  }
  const organizationIds = strictViewerScopeOrganizationIds(viewer);
  if (
    organizationIds !== 'all' &&
    (!currentOrganization || !organizationIds.includes(currentOrganization))
  ) {
    throw new Error('viewer is not authorized for this work item organization');
  }
  const projectIds = strictViewerScopeProjectIds(viewer);
  if (projectIds !== 'all' && (!currentProject || !projectIds.includes(currentProject))) {
    throw new Error('viewer is not authorized for this work item project');
  }
  return withViewerExecutionContext(viewer, () => updateWorkItem({ itemId, status }));
}
