import { NextRequest, NextResponse } from 'next/server';
import { CloudflareOsControlPlane } from '@agent/core/cloudflare-os-control-plane';
import {
  createShareGrantRegistryAuthorizer,
  shareGrantActorFromViewer,
} from '@agent/core/share-grant-authorizer';
import { ProvenanceTaintPolicyError } from '@agent/core/provenance-taint';
import {
  ShareGrantAuthorizationError,
  ShareGrantGraph,
  ShareGrantValidationError,
} from '@agent/core/share-grant-graph';
import { ShareGrantLiveSessionRegistry } from '@agent/core/share-grant-live-sessions';
import { resolveTenant } from '@agent/core/tenant-registry';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/viewer-context';
import { readChronosJsonObject } from '../../../../lib/request-input';
import { parseShareGrantInput } from './share-grant-input';

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const parsedBody = await readChronosJsonObject(req, 'Chronos share grants');
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    let input;
    try {
      input = parseShareGrantInput(parsedBody.body);
    } catch (error) {
      return viewerErrorResponse(error, 400);
    }
    const actor = shareGrantActorFromViewer(resolvedViewer.context);

    const result = withViewerExecutionContext(resolvedViewer.context, () => {
      switch (input.operation) {
        case 'register_resource':
          return shareGrantGraph.registerResource({
            resourceRef: input.resourceRef,
            tenantSlug: input.tenantSlug,
            taint: input.taint,
            actor,
            ...(input.provenanceMissionId
              ? { provenanceMissionId: input.provenanceMissionId }
              : {}),
          });
        case 'grant_edge':
          return shareGrantGraph.grantEdge({
            resourceRef: input.resourceRef,
            grantee: input.grantee,
            targetTenantSlug: input.targetTenantSlug,
            role: input.role,
            actor,
            ...(input.audienceFloor ? { audienceFloor: input.audienceFloor } : {}),
          });
        case 'revoke_edge':
          return shareGrantGraph.revokeEdge(input.edgeId, actor);
        case 'issue_link':
          return shareGrantGraph.issueShareLink({
            resourceRef: input.resourceRef,
            role: input.role,
            actor,
            ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
            ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            ...(input.audienceFloor ? { audienceFloor: input.audienceFloor } : {}),
          });
        case 'revoke_link':
          return shareGrantGraph.revokeShareLink(input.linkId, actor);
        case 'register_session':
          return shareGrantGraph.openShareLinkSession({
            resourceRef: input.resourceRef,
            token: input.token,
            sessionId: input.sessionId,
            connectedAt: input.connectedAt || new Date().toISOString(),
          });
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
