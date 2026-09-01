import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';

import {
  getChronosAccessRoleOrThrow,
  guardRequest,
  roleToMissionRole,
} from '../../../lib/api-guard';
import { findMissionPath, pathResolver } from '@agent/core/path-resolver';
import { loadArtifactRecord } from '@agent/core/artifact-record';
import {
  assertSafeRepositoryPath,
  loadJson,
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

type AssetTier = 'personal' | 'confidential' | 'public';

function normalizeAssetPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/');
  const root = pathResolver.rootDir().replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function tierFromPath(value: string | undefined): AssetTier | undefined {
  const normalized = normalizeAssetPath(value);
  const match = normalized?.match(
    /(?:^|\/)active\/(?:missions|projects)\/(personal|confidential|public)(?:\/|$)/
  );
  return match?.[1] as AssetTier | undefined;
}

function tenantFromPath(value: string | undefined): string | undefined {
  const normalized = normalizeAssetPath(value);
  const match = normalized?.match(
    /^active\/(?:missions|projects)\/(?:personal|confidential|public)\/([^/]+)\//
  );
  return match?.[1] && match[1] !== 'shared' ? match[1] : undefined;
}

function missionTier(missionId: string): AssetTier | undefined {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  try {
    const statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(statePath) || !safeLstat(statePath).isFile()) {
      return tierFromPath(missionPath);
    }
    const state = loadJson<{ tier?: unknown }>(statePath);
    if (state.tier === 'personal' || state.tier === 'confidential' || state.tier === 'public') {
      return state.tier;
    }
  } catch {
    // Fall back to the governed mission directory shape below.
  }
  return tierFromPath(missionPath);
}

function artifactTenant(artifact: {
  tenant_slug?: string;
  mission_id?: string;
}): string | undefined {
  if (artifact.tenant_slug) return artifact.tenant_slug;
  if (!artifact.mission_id) return undefined;
  const missionPath = findMissionPath(artifact.mission_id);
  if (!missionPath) return undefined;
  try {
    const statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(statePath) || !safeLstat(statePath).isFile()) return undefined;
    const state = loadJson<{
      tenant_slug?: string;
      tenant_id?: string;
    }>(statePath);
    return state.tenant_slug || state.tenant_id;
  } catch {
    return undefined;
  }
}

export function resolveMissionAssetTier(input: {
  artifact?: Parameters<typeof inferDeliverableTier>[0];
  assetPath?: string;
  missionId?: string;
}): AssetTier | undefined {
  const resolvedMissionTier = input.missionId ? missionTier(input.missionId) : undefined;
  const pathTier = tierFromPath(input.assetPath);
  if (resolvedMissionTier || pathTier) return resolvedMissionTier || pathTier;
  return inferDeliverableTier(
    input.artifact || { kind: '', storage_class: 'external_ref', artifact_id: '' },
    normalizeAssetPath(input.artifact?.path),
    undefined
  );
}

export function resolveMissionAssetTenant(input: {
  artifact?: Parameters<typeof inferDeliverableTier>[0];
  assetPath?: string;
  missionId?: string;
}): string | undefined {
  return (
    tenantFromPath(input.assetPath) ||
    (input.artifact ? artifactTenant(input.artifact) : undefined) ||
    (input.missionId ? artifactTenant({ mission_id: input.missionId }) : undefined)
  );
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

    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);

    const missionId = req.nextUrl.searchParams.get('missionId') || '';
    const relativePath = req.nextUrl.searchParams.get('path') || '';
    const artifactId = req.nextUrl.searchParams.get('artifactId') || '';
    let artifact: Parameters<typeof inferDeliverableTier>[0] | undefined;
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      req.nextUrl.searchParams.get('tenant') || undefined
    );
    if (artifactId) {
      artifact = loadArtifactRecord(artifactId);
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
      const missionRoot = resolveMissionRoot(missionId);
      if (!missionRoot) {
        return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
      }
      assetPath = path.join(missionRoot, relativePath);
      assetTier = resolveMissionAssetTier({
        artifact: artifactId ? artifact : undefined,
        assetPath,
        missionId,
      });
    } else {
      // repo-relative artifact mode: deliverables live in exports/tmp/missions;
      // tier enforcement stays with secure-io on the actual read below.
      const repoRelative = toRepoRelative(relativePath);
      if (!repoRelative || !isAllowedRepoAssetPath(repoRelative)) {
        return NextResponse.json({ error: 'Invalid mission asset request' }, { status: 400 });
      }
      assetPath = path.join(pathResolver.rootDir(), repoRelative);
      assetTier = resolveMissionAssetTier({
        artifact: artifactId ? artifact : undefined,
        assetPath,
      });
    }
    try {
      assetPath = assertSafeRepositoryPath(assetPath, { allowMissingLeaf: true });
    } catch {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
    }
    const pathTenant = tenantFromPath(assetPath);
    const boundTenant = resolveMissionAssetTenant({
      artifact: artifactId ? artifact : undefined,
      missionId: missionId || undefined,
    });
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
