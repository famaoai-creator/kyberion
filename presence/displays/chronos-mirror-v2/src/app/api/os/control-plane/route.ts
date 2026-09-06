import { NextRequest, NextResponse } from 'next/server';
import {
  CloudflareOsReadOnlySurface,
  type CloudflareOsSurfaceAccess,
} from '@agent/core/cloudflare-os-surface';
import { guardRequest, requireChronosAccess } from '../../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  resolveViewerTierAccess,
  viewerErrorResponse,
  withViewerExecutionContext,
  type ViewerContext,
} from '../../../../lib/viewer-context';
import { readChronosOptionalStringParam } from '../../../../lib/request-input';

const cloudflareOsSurface = new CloudflareOsReadOnlySurface();

export function buildSurfaceAccess(viewer: ViewerContext): CloudflareOsSurfaceAccess {
  if (viewer.role !== 'localadmin' && viewer.tenantSlugs === 'all') {
    throw new Error(
      '[POLICY_VIOLATION] Chronos OS projection requires a tenant-scoped viewer registration'
    );
  }
  const actor = viewer.principalId || viewer.source || viewer.role;
  return {
    principalId: `human:chronos:${actor}`,
    tenantSlugs: viewer.tenantSlugs,
    tierAccess: resolveViewerTierAccess(viewer.role, viewer.tierAccess),
  };
}

export function snapshotForViewer(
  viewer: ViewerContext,
  missionId: string | undefined,
  surface: Pick<CloudflareOsReadOnlySurface, 'snapshot'> = cloudflareOsSurface
) {
  const access = buildSurfaceAccess(viewer);
  return withViewerExecutionContext(viewer, () => surface.snapshot(missionId, access));
}

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const url = new URL(req.url);
    const missionId = readChronosOptionalStringParam(url.searchParams.get('mission_id'));
    const snapshot = snapshotForViewer(resolvedViewer.context, missionId);
    return NextResponse.json(
      { ok: true, ...snapshot },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
