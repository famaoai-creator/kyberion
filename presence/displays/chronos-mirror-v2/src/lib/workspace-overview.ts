import path from 'node:path';
import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';
import type { WorkspaceOverview } from '@agent/core/surface/workspace';
import { readWorkspaceAutonomy } from '@agent/core/surface/workspace-autonomy';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { workspaceQuery } from '@agent/core/surface/workspace-query';
import { workspaceWorkItemVisible } from '@agent/core/surface/workspace-work';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';
import { listWorkItems } from '@agent/core/workforce/work-coordination';
import { loadProjectRecord } from '@agent/core/project/project-registry';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import {
  loadOrganizationOperationalState,
  loadOrganizationPurpose,
} from '@agent/core/organization/organization-operating-model-persistence';
import { listOrganizationOperationRuns } from '@agent/core/organization/organization-operating-model-operations';
import { collectDeliverableInbox } from './deliverable-inbox';
import { buildApprovalQueueItems } from './su-surface-data';
import {
  withViewerExecutionContext,
  toSurfaceAuthorizationContext,
  ViewerContextError,
  type ViewerContext,
} from './viewer-context';
import { resolveChronosWorkspace } from './workspace-scope';

export function collectWorkspaceOverview(
  viewer: ViewerContext,
  requested: WorkspaceSelection
): WorkspaceOverview {
  const scope = resolveChronosWorkspace(viewer, requested);
  const selection = scope.selection;
  const resource = {
    tenantSlug: selection.tenant_slug,
    organizationId: selection.organization_id,
    projectId: selection.project_id,
    tier: selection.tier,
  };
  const authorization = toSurfaceAuthorizationContext(viewer);
  const allowed = authorizeSurfaceContextOperation({
    context: authorization,
    operation: {
      operationId: 'chronos.workspace.read',
      effect: 'read',
      requiredRole: 'readonly',
      requiredPermissions: ['surface.headless.read'],
    },
    resource,
    surface: 'chronos',
  });
  if (!allowed.allowed) throw new ViewerContextError(403, allowed.reason);
  const narrowedViewer = {
    ...viewer,
    tenantSlugs: scope.tenantSlugs,
    organizationIds: scope.organizationIds,
    projectIds: scope.projectIds,
    tierAccess: scope.tierAccess,
  };
  const unavailable: string[] = [];
  const read = <T>(source: string, fn: () => T, fallback: T): T => {
    try {
      return withViewerExecutionContext(narrowedViewer, fn);
    } catch {
      unavailable.push(source);
      return fallback;
    }
  };
  const owner: WorkspaceOverview['owner'] = {
    id:
      selection.operation_id ??
      selection.project_id ??
      selection.organization_id ??
      selection.tenant_slug ??
      'viewer',
    name: '',
    kind: selection.kind,
  };
  owner.name = owner.id;
  let goal: string | null = null;
  const canReadOwner =
    selection.project_id ||
    (viewer.projectIds === 'all' &&
      (selection.organization_id || viewer.organizationIds === 'all'));
  if (canReadOwner) {
    read(
      'owner',
      () => {
        if (scope.operation) {
          owner.name = scope.operation.name;
          owner.status = scope.operation.status;
          goal = scope.operation.purpose ?? null;
        } else if (selection.project_id) {
          const record = loadProjectRecord(selection.project_id);
          if (!record) throw new Error('missing');
          owner.name = record.name;
          owner.status = record.status;
          goal = record.summary;
        } else if (selection.organization_id) {
          const query = { tier: selection.tier, tenantSlug: selection.tenant_slug };
          const record = loadOrganizationOperationalState(selection.organization_id, query);
          if (!record) throw new Error('missing');
          owner.name = record.name;
          owner.status = record.status;
          goal = loadOrganizationPurpose(selection.organization_id, query)?.purpose ?? null;
        } else if (selection.tenant_slug) {
          if (viewer.role !== 'localadmin') return true;
          const record = readTenantProfile(selection.tenant_slug);
          if (!record) throw new Error('missing');
          owner.name = record.display_name;
          owner.status = record.status;
        }
        return true;
      },
      false
    );
  }
  const items = read(
    'work',
    () => {
      const delegated = listWorkItems({
        tenantSlugs: scope.tenantSlugs === 'all' ? undefined : scope.tenantSlugs,
        organizationIds: scope.organizationIds === 'all' ? undefined : scope.organizationIds,
        projectIds: scope.projectIds === 'all' ? undefined : scope.projectIds,
      })
        .filter((item) => workspaceWorkItemVisible(item, scope))
        .map((item) => ({ id: item.item_id, title: item.title, status: item.status }));
      if (selection.operation_id)
        return [
          ...delegated,
          ...listOrganizationOperationRuns({
            organizationId: selection.organization_id,
            tenantSlug: selection.tenant_slug,
            tier: selection.tier,
          })
            .filter((run) => run.operation_id === selection.operation_id)
            .map((run) => ({
              id: run.run_id,
              title: run.result_summary ?? run.run_id,
              status: run.status,
            })),
        ];
      return delegated;
    },
    []
  );
  const artifacts = read(
    'library',
    () =>
      collectDeliverableInbox({
        tenantSlugs: scope.tenantSlugs,
        organizationIds: scope.organizationIds,
        projectIds: scope.projectIds,
        tier: selection.tier ?? '',
        tierAccess: scope.tierAccess,
        limit: 50,
      }).map((item) => ({
        id: item.artifactId,
        kind: item.kind,
        name: item.path ? path.basename(item.path) : item.artifactId,
      })),
    []
  );
  const approvals = read(
    'decisions',
    () =>
      buildApprovalQueueItems({
        viewer: narrowedViewer,
        workspace: scope,
        tenantSlugs: scope.tenantSlugs,
        limit: 50,
      }).map((item) => ({ id: item.id, title: item.title, status: item.status })),
    []
  );
  const autonomy = read('autonomy', () => readWorkspaceAutonomy(selection, narrowedViewer), {
    dots: [],
    pauseMeaning: 'future_wakeups_only' as const,
    blockedReasons: ['Autonomy information is unavailable.'],
  });
  const conversation = new URL(resolveSurfaceBrowserUrl('concierge'));
  conversation.search = workspaceQuery(selection).toString();
  const addResource = new URL(conversation);
  addResource.pathname = `${addResource.pathname.replace(/\/$/, '')}/ingest`;
  return {
    selection,
    owner,
    goal,
    work: {
      items: items.slice(0, 50),
      counts: {
        total: items.length,
        active: items.filter((item) =>
          ['ready', 'in_progress', 'review', 'started', 'running'].includes(item.status)
        ).length,
        blocked: items.filter((item) => ['blocked', 'failed'].includes(item.status)).length,
      },
    },
    library: {
      artifacts,
      ...(selection.operation_id ? { inheritedFrom: 'organization' as const } : {}),
    },
    decisions: { approvals },
    autonomy,
    capabilities: {
      canControlAutonomy:
        autonomy.dots.length > 0 &&
        authorizeSurfaceContextOperation({
          context: authorization,
          operation: {
            operationId: 'chronos.workspace.autonomy.control',
            effect: 'write',
            requiredRole: 'localadmin',
            requiredPermissions: ['surface.headless.write'],
          },
          resource,
          surface: 'chronos',
        }).allowed,
    },
    unavailable,
    ...(selection.tier === 'personal'
      ? {}
      : { links: { conversation: conversation.toString(), addResource: addResource.toString() } }),
  };
}
