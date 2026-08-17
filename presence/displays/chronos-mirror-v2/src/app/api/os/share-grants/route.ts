import { NextRequest, NextResponse } from 'next/server';
import {
  CloudflareOsControlPlane,
  createShareGrantRegistryAuthorizer,
  ProvenanceTaintPolicyError,
  ShareGrantAuthorizationError,
  ShareGrantGraph,
  ShareGrantLiveSessionRegistry,
  ShareGrantValidationError,
  resolveTenant,
  shareGrantActorFromViewer,
} from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';

const cloudflareOsControlPlane = new CloudflareOsControlPlane();
const shareGrantLiveSessions = new ShareGrantLiveSessionRegistry({ persist: true });

const shareGrantGraph = new ShareGrantGraph({
  authorizeActor: createShareGrantRegistryAuthorizer(),
  resolveTenant: (tenantSlug) => {
    try {
      return resolveTenant(tenantSlug).profile;
    } catch {
      return null;
    }
  },
  resolveProvenance: (missionId) => cloudflareOsControlPlane.projectTaint(missionId),
  liveSessionEvictor: shareGrantLiveSessions,
});

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function badRequest(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const operation = isString(body.operation) ? body.operation : '';
    const resourceRef = isString(body.resourceRef) ? body.resourceRef : '';
    const actor = shareGrantActorFromViewer(resolvedViewer.context);

    const result = withViewerExecutionContext(resolvedViewer.context, () => {
      switch (operation) {
        case 'register_resource':
          if (
            !resourceRef ||
            !isString(body.tenantSlug) ||
            !isString(body.taint) ||
            (body.taint !== 'public' && !isString(body.provenanceMissionId))
          ) {
            return badRequest(
              'operation, resourceRef, tenantSlug, and taint are required; provenanceMissionId is also required for non-public taint'
            );
          }
          return shareGrantGraph.registerResource({
            resourceRef,
            tenantSlug: body.tenantSlug,
            taint: body.taint as 'personal' | 'confidential' | 'public',
            actor,
            ...(isString(body.provenanceMissionId)
              ? { provenanceMissionId: body.provenanceMissionId }
              : {}),
          });
        case 'grant_edge':
          if (
            !resourceRef ||
            !isString(body.grantee) ||
            !isString(body.targetTenantSlug) ||
            !isString(body.role)
          ) {
            return badRequest(
              'operation, resourceRef, grantee, targetTenantSlug, and role are required'
            );
          }
          return shareGrantGraph.grantEdge({
            resourceRef,
            actor,
            grantee: body.grantee,
            targetTenantSlug: body.targetTenantSlug,
            role: body.role as 'view' | 'operate',
            ...(isString(body.audienceFloor)
              ? {
                  audienceFloor: body.audienceFloor as 'personal' | 'confidential' | 'public',
                }
              : {}),
          });
        case 'revoke_edge':
          if (!isString(body.edgeId)) return badRequest('edgeId is required');
          return shareGrantGraph.revokeEdge(body.edgeId, actor);
        case 'issue_link':
          if (!resourceRef || !isString(body.role)) {
            return badRequest('operation, resourceRef, and role are required');
          }
          return shareGrantGraph.issueShareLink({
            resourceRef,
            actor,
            role: body.role as 'view' | 'operate',
            ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
            ...(isString(body.expiresAt) ? { expiresAt: body.expiresAt } : {}),
            ...(isString(body.audienceFloor)
              ? {
                  audienceFloor: body.audienceFloor as 'personal' | 'confidential' | 'public',
                }
              : {}),
          });
        case 'revoke_link':
          if (!isString(body.linkId)) return badRequest('linkId is required');
          return shareGrantGraph.revokeShareLink(body.linkId, actor);
        case 'register_session':
          if (!resourceRef || !isString(body.token) || !isString(body.sessionId)) {
            return badRequest('operation, resourceRef, token, and sessionId are required');
          }
          return shareGrantGraph.openShareLinkSession({
            resourceRef,
            token: body.token,
            sessionId: body.sessionId,
            connectedAt: isString(body.connectedAt) ? body.connectedAt : new Date().toISOString(),
          });
        default:
          return badRequest('unknown share grant operation');
      }
    });

    if (result instanceof NextResponse) return result;
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof ShareGrantAuthorizationError) {
      return viewerErrorResponse(error, 403);
    }
    if (error instanceof ShareGrantValidationError) {
      return viewerErrorResponse(error, 400);
    }
    if (error instanceof ProvenanceTaintPolicyError) {
      return viewerErrorResponse(error, 403);
    }
    if (error instanceof Error && error.message.includes('viewer')) {
      return viewerErrorResponse(error);
    }
    return viewerErrorResponse(error, 500);
  }
}
