import { NextRequest, NextResponse } from 'next/server';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import { listProjectRecords } from '@agent/core/project-registry';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import { loadState } from '@agent/core/mission-state';
import { findMissionPath } from '@agent/core/path-resolver';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerTier,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { inferDeliverableTier } from '../../../lib/deliverable-inbox';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';

function artifactTenant(artifact: {
  tenant_slug?: string;
  mission_id?: string;
}): string | undefined {
  if (artifact.tenant_slug) return artifact.tenant_slug;
  if (!artifact.mission_id) return undefined;
  const missionPath = findMissionPath(artifact.mission_id);
  if (!missionPath) return undefined;
  try {
    const state = loadState(artifact.mission_id);
    return state?.tenant_slug || state?.tenant_id;
  } catch {
    return undefined;
  }
}

function missionTier(missionId?: string): OsKnowledgeTier | undefined {
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  try {
    const state = loadState(missionId);
    return state?.tier === 'personal' || state?.tier === 'confidential' || state?.tier === 'public'
      ? state.tier
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDeliverablePreviewTier(
  artifact: Parameters<typeof inferDeliverableTier>[0]
): OsKnowledgeTier | undefined {
  const projectTier = artifact.project_id
    ? listProjectRecords().find((project) => project.project_id === artifact.project_id)?.tier
    : undefined;
  return inferDeliverableTier(
    artifact,
    artifact.path?.replace(/\\/g, '/'),
    projectTier || missionTier(artifact.mission_id)
  );
}

/**
 * Preview endpoint for artifact records that contain governed inline content
 * but do not point at a filesystem asset. Keeping this behind the same viewer
 * and tenant checks as /api/mission-asset makes the UI's "open" action useful
 * without creating a second authorization path.
 */
export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const artifactId = readChronosStringParam(req.nextUrl.searchParams.get('artifactId'));
    if (!artifactId) {
      return NextResponse.json({ error: 'Missing artifactId' }, { status: 400 });
    }
    const artifact = withViewerExecutionContext(resolvedViewer.context, () =>
      loadArtifactRecord(artifactId)
    );
    if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });

    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
    if (
      tenantSlugs !== 'all' &&
      (!artifactTenant(artifact) || !tenantSlugs.includes(artifactTenant(artifact)!))
    ) {
      return NextResponse.json(
        { error: 'Deliverable is outside the viewer tenant scope' },
        { status: 403 }
      );
    }
    const tier = resolveDeliverablePreviewTier(artifact);
    if (!tier) {
      return NextResponse.json({ error: 'Deliverable tier is unavailable' }, { status: 403 });
    }
    strictViewerTier(resolvedViewer.context, tier);

    const body = artifact.preview_text?.trim();
    if (!body) {
      return NextResponse.json(
        { error: 'This deliverable has no inline preview' },
        { status: 404 }
      );
    }
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${artifact.artifact_id}.txt"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
}
