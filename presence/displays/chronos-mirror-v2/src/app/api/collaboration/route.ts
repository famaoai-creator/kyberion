import { NextRequest, NextResponse } from 'next/server';
import { buildAgentCollaborationProjection } from '@agent/core/agent-collaboration-projection';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  viewerScopeTenantSlugs,
} from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const rawLimit = Number(req.nextUrl.searchParams.get('limit') || 100);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 500)) : 100;
  const missionId = req.nextUrl.searchParams.get('mission') || undefined;
  const tenant = req.nextUrl.searchParams.get('tenant') || undefined;
  try {
    const tenantSlugs = viewerScopeTenantSlugs(resolvedViewer.context, tenant);
    const projection = buildAgentCollaborationProjection({
      missionId,
      tenant: tenantSlugs === 'all' || tenantSlugs.length !== 1 ? undefined : tenantSlugs[0],
      tenantSlugs,
      limit,
    });
    return NextResponse.json({ ok: true, projection });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
