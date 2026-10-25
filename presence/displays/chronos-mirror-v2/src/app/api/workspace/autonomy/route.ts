import { NextRequest, NextResponse } from 'next/server';
import type { WorkspaceSelection } from '@agent/core/surface/workspace-scope';
import { controlWorkspaceAutonomy } from '@agent/core/surface/workspace-autonomy';
import { authorizeSurfaceContextOperation } from '@agent/core/surface/surface-authn';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  toSurfaceAuthorizationContext,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';
import { resolveChronosWorkspace } from '../../../../lib/workspace-scope';
export async function POST(req: NextRequest) {
  const denied = guardRequest(req) ?? requireChronosAccess(req, 'localadmin');
  if (denied) return denied;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid autonomy request.');
    const input = body as Record<string, unknown>;
    const keys = [
      'tenant_slug',
      'organization_id',
      'project_id',
      'operation_id',
      'tier',
      'dot_id',
      'action',
    ];
    if (
      Object.keys(input).some((key) => !keys.includes(key)) ||
      typeof input.dot_id !== 'string' ||
      !['pause', 'resume', 'activate'].includes(String(input.action))
    )
      throw new Error('Invalid autonomy request.');
    const requested: WorkspaceSelection = {};
    for (const key of [
      'tenant_slug',
      'organization_id',
      'project_id',
      'operation_id',
      'tier',
    ] as const) {
      if (input[key] !== undefined) Object.assign(requested, { [key]: input[key] });
    }
    const scope = resolveChronosWorkspace(resolvedViewer.context, requested);
    const selection = scope.selection;
    const decision = authorizeSurfaceContextOperation({
      context: toSurfaceAuthorizationContext(resolvedViewer.context),
      operation: {
        operationId: 'chronos.workspace.autonomy.control',
        effect: 'write',
        requiredRole: 'localadmin',
        requiredPermissions: ['surface.headless.write'],
      },
      resource: {
        tenantSlug: selection.tenant_slug,
        organizationId: selection.organization_id,
        projectId: selection.project_id,
        tier: selection.tier,
      },
      surface: 'chronos',
    });
    if (!decision.allowed) throw new Error(decision.reason);
    const viewer = {
      ...resolvedViewer.context,
      tenantSlugs: scope.tenantSlugs,
      organizationIds: scope.organizationIds,
      projectIds: scope.projectIds,
      tierAccess: scope.tierAccess,
    };
    const charter = withViewerExecutionContext(viewer, () =>
      controlWorkspaceAutonomy(
        selection,
        viewer,
        { dot_id: input.dot_id as string, action: input.action as 'pause' | 'resume' | 'activate' },
        { actor: viewer.principalId }
      )
    );
    return NextResponse.json({
      ok: true,
      dot_id: charter.dot_id,
      status: charter.status,
      affects: 'future_wakeups_only',
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
