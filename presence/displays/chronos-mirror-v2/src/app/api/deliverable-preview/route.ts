import { NextRequest, NextResponse } from 'next/server';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import { findMissionPath } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

function artifactTenant(artifact: {
  tenant_slug?: string;
  mission_id?: string;
}): string | undefined {
  if (artifact.tenant_slug) return artifact.tenant_slug;
  if (!artifact.mission_id) return undefined;
  const missionPath = findMissionPath(artifact.mission_id);
  if (!missionPath) return undefined;
  const statePath = `${missionPath}/mission-state.json`;
  if (!safeExistsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as {
      tenant_slug?: string;
      tenant_id?: string;
    };
    return state.tenant_slug || state.tenant_id;
  } catch {
    return undefined;
  }
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
    const artifactId = req.nextUrl.searchParams.get('artifactId')?.trim() || '';
    if (!artifactId) {
      return NextResponse.json({ error: 'Missing artifactId' }, { status: 400 });
    }
    const artifact = withViewerExecutionContext(resolvedViewer.context, () =>
      loadArtifactRecord(artifactId)
    );
    if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });

    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      req.nextUrl.searchParams.get('tenant') || undefined
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
