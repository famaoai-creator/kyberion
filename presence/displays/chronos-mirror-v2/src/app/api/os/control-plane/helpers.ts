import {
  CloudflareOsReadOnlySurface,
  type CloudflareOsSurfaceAccess,
} from '@agent/core/cloudflare-os-surface';
import {
  resolveViewerTierAccess,
  withViewerExecutionContext,
  type ViewerContext,
} from '../../../../lib/viewer-context';

export const cloudflareOsSurface = new CloudflareOsReadOnlySurface();

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
