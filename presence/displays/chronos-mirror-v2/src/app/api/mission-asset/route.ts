import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';

import { guardRequest } from '../../../lib/api-guard';
import { pathResolver } from '@agent/core/path-resolver';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';
import {
  resolveViewerContextForRequest,
  strictViewerTier,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { inferDeliverableTier } from '../../../lib/deliverable-inbox';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';
import {
  artifactTenant,
  resolveMissionAssetTier,
  resolveMissionAssetTenant,
  tenantFromPath,
  type AssetTier,
} from './helpers';

const ALLOWED_PREFIXES = ['deliverables/', 'artifacts/', 'outputs/', 'evidence/'] as const;
// Repo-relative mode (no missionId): where governed artifacts actually live.
const ALLOWED_REPO_PREFIXES = [
  'active/shared/exports/',
  'active/shared/tmp/',
  'active/missions/',
  'active/projects/',
] as const;

function resolveMissionRoot(missionId: string): string | null {
  const roots = [
    pathResolver.active('missions/public'),
    pathResolver.active('missions/confidential'),
  ];

  for (const root of roots) {
    try {
      const safeRoot = assertSafeRepositoryPath(root, { allowMissingLeaf: true });
      const candidate = assertSafeRepositoryPath(path.join(safeRoot, missionId), {
        allowMissingLeaf: true,
      });
      if (safeExistsSync(candidate) && safeLstat(candidate).isDirectory()) return candidate;
    } catch {
      // A missing, symlinked, or malformed mission root is not a readable asset scope.
    }
  }

  return null;
}

function isAllowedMissionAssetPath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.includes('..')) return false;
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Absolute paths under the repo root are tolerated and normalized. */
function toRepoRelative(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  if (!path.isAbsolute(normalized)) return normalized;
  const root = pathResolver.rootDir().replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized.startsWith(`${root}/`)) return null;
  return normalized.slice(root.length + 1);
}

function isAllowedRepoAssetPath(relativePath: string): boolean {
  return ALLOWED_REPO_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.json':
      return 'application/json; charset=utf-8';
    case '.md':
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

export async function GET(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const resolvedViewer = resolveViewerContextForRequest(req);
    if (resolvedViewer.response) return resolvedViewer.response;

    const withViewerContext = <T>(operation: () => T): T =>
      withViewerExecutionContext(resolvedViewer.context, operation);

    const missionId = readChronosStringParam(req.nextUrl.searchParams.get('missionId'));
    const relativePath = readChronosStringParam(req.nextUrl.searchParams.get('path'));
    const artifactId = readChronosStringParam(req.nextUrl.searchParams.get('artifactId'));
    let artifact: Parameters<typeof inferDeliverableTier>[0] | undefined;
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
    if (artifactId) {
      artifact = withViewerContext(() => loadArtifactRecord(artifactId));
      if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
      if (
        tenantSlugs !== 'all' &&
        (!artifactTenant(artifact) || !tenantSlugs.includes(artifactTenant(artifact)!))
      ) {
        return NextResponse.json(
          { error: 'Asset is outside the viewer tenant scope' },
          { status: 403 }
        );
      }
    }

    let assetPath: string;
    let assetTier: AssetTier | undefined;
    if (missionId) {
      if (!isAllowedMissionAssetPath(relativePath)) {
        return NextResponse.json({ error: 'Invalid mission asset request' }, { status: 400 });
      }
      const missionRoot = withViewerContext(() => resolveMissionRoot(missionId));
      if (!missionRoot) {
        return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
      }
      assetPath = path.join(missionRoot, relativePath);
      assetTier = withViewerContext(() =>
        resolveMissionAssetTier({
          artifact: artifactId ? artifact : undefined,
          assetPath,
          missionId,
        })
      );
    } else {
      // repo-relative artifact mode: deliverables live in exports/tmp/missions;
      // tier enforcement stays with secure-io on the actual read below.
      const repoRelative = toRepoRelative(relativePath);
      if (!repoRelative || !isAllowedRepoAssetPath(repoRelative)) {
        return NextResponse.json({ error: 'Invalid mission asset request' }, { status: 400 });
      }
      assetPath = path.join(pathResolver.rootDir(), repoRelative);
      assetTier = withViewerContext(() =>
        resolveMissionAssetTier({
          artifact: artifactId ? artifact : undefined,
          assetPath,
        })
      );
    }
    try {
      assetPath = withViewerContext(() =>
        assertSafeRepositoryPath(assetPath, { allowMissingLeaf: true })
      );
    } catch {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }
    const pathTenant = tenantFromPath(assetPath);
    const boundTenant = withViewerContext(() =>
      resolveMissionAssetTenant({
        artifact: artifactId ? artifact : undefined,
        missionId: missionId || undefined,
      })
    );
    if (pathTenant && boundTenant && pathTenant !== boundTenant) {
      return NextResponse.json(
        { error: 'Asset tenant binding does not match its path' },
        { status: 403 }
      );
    }
    const assetTenant = pathTenant || boundTenant;
    if (assetTenant && tenantSlugs !== 'all' && !tenantSlugs.includes(assetTenant)) {
      return NextResponse.json(
        { error: 'Asset is outside the viewer tenant scope' },
        { status: 403 }
      );
    }
    if (!assetTier) {
      return NextResponse.json({ error: 'Asset tier is unavailable' }, { status: 403 });
    }
    try {
      strictViewerTier(resolvedViewer.context, assetTier);
    } catch (error) {
      return viewerErrorResponse(error, 403);
    }
    return withViewerExecutionContext(resolvedViewer.context, () => {
      if (!safeExistsSync(assetPath)) {
        return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
      }

      const stats = safeLstat(assetPath);
      if (!stats.isFile()) {
        return NextResponse.json({ error: 'Asset is not a file' }, { status: 400 });
      }

      const content = safeReadFile(assetPath, { encoding: null }) as Buffer;
      return new NextResponse(new Uint8Array(content), {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(assetPath),
          'Content-Length': String(stats.size),
          'Content-Disposition': `inline; filename="${path.basename(assetPath)}"`,
          'Cache-Control': 'no-store',
        },
      });
    });
  } catch (err: any) {
    return viewerErrorResponse(err, err instanceof ViewerContextError ? err.status : 500);
  }
}
