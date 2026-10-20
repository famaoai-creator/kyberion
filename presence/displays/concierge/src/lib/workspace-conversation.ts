import { resolveWorkspaceScope } from '@agent/core/surface/workspace-scope';
import {
  narrowFrontDeskConversationViewer,
  type FrontDeskConversationViewer,
} from '@agent/core/surface/front-desk-conversation-store';
import { withExecutionContext } from '@agent/core/authority';

/** Validate the selected registry chain before it can choose a transcript. */
export function workspaceConversationViewer(
  viewer: FrontDeskConversationViewer,
  selection: {
    tenant?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
    operationId?: string | null;
  }
): FrontDeskConversationViewer {
  if (!Object.values(selection).some((value) => value !== undefined && value !== null))
    return viewer;
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  const scope = withExecutionContext(
    'sovereign_concierge',
    () =>
      resolveWorkspaceScope(viewer, {
        tenant_slug: selection.tenant ?? undefined,
        organization_id: selection.organizationId ?? undefined,
        project_id: selection.projectId ?? undefined,
        operation_id: selection.operationId ?? undefined,
      }),
    undefined,
    tenant
  );
  return {
    ...narrowFrontDeskConversationViewer(viewer, {
      tenant: scope.selection.tenant_slug,
      organizationId: scope.selection.organization_id,
      projectId: scope.selection.project_id,
    }),
    tierAccess: scope.tierAccess,
    ...(scope.selection.operation_id ? { workspaceOperationId: scope.selection.operation_id } : {}),
  };
}
