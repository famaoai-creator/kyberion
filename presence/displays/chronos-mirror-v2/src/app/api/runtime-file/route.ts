import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { pathResolver } from '@agent/core/path-resolver';
import { listProjectRecords, type ProjectRecord } from '@agent/core/project-registry';
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
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { normalizeScopedReadPath } from '../../../lib/scoped-read-path';

function isAllowedRuntimeRefPath(logicalPath: string): boolean {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return false;
  if (!/^active\/projects\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.active('projects'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export function resolveSafeRuntimeReferencePath(logicalPath: string): string | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized || !isAllowedRuntimeRefPath(normalized)) return null;
  try {
    const resolved = assertSafeRepositoryPath(pathResolver.resolve(normalized), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

type RuntimeReferenceScope = {
  tier: 'personal' | 'confidential' | 'public';
  tenantSlug?: string;
};

function isRuntimeTier(value: string | undefined): value is RuntimeReferenceScope['tier'] {
  return value === 'personal' || value === 'confidential' || value === 'public';
}

/** Resolve project-file scope from the governed path or its project registry. */
export function resolveRuntimeReferenceScope(
  logicalPath: string,
  projects: readonly ProjectRecord[] = listProjectRecords()
): RuntimeReferenceScope | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return null;
  const parts = normalized.split('/');
  // The canonical layout is active/projects/{tier}/{tenantOrShared}/{project}/... .
  // A shorter active/projects/{tier}/{project}/... path is legacy and must be
  // resolved through the governed project registry instead of treating the
  // first file/directory segment as a tenant slug.
  if (
    parts[0] === 'active' &&
    parts[1] === 'projects' &&
    isRuntimeTier(parts[2]) &&
    parts.length >= 5
  ) {
    return {
      tier: parts[2],
      ...(parts[3] && parts[3] !== 'shared' ? { tenantSlug: parts[3] } : {}),
    };
  }

  const resolved = path.resolve(pathResolver.resolve(normalized));
  const project = projects.find((candidate) =>
    (candidate.repositories || []).some((repository) => {
      if (!repository.root_path) return false;
      const root = path.resolve(pathResolver.resolve(repository.root_path));
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    })
  );
  return project
    ? {
        tier: project.tier,
        ...(project.tenant_slug ? { tenantSlug: project.tenant_slug } : {}),
      }
    : null;
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const logicalPath = String(req.nextUrl.searchParams.get('path') || '').trim();
  if (!logicalPath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }
  const normalizedPath = normalizeScopedReadPath(logicalPath);
  if (!normalizedPath || !isAllowedRuntimeRefPath(normalizedPath)) {
    return NextResponse.json(
      { error: `runtime ref is not accessible: ${logicalPath}` },
      { status: 403 }
    );
  }
  const scope = resolveRuntimeReferenceScope(normalizedPath);
  if (!scope) {
    return NextResponse.json({ error: 'Runtime ref scope is unavailable' }, { status: 403 });
  }
  try {
    strictViewerTier(resolvedViewer.context, scope.tier);
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, scope.tenantSlug);
    if (scope.tenantSlug && tenantSlugs !== 'all' && !tenantSlugs.includes(scope.tenantSlug)) {
      return NextResponse.json(
        { error: 'Runtime ref is outside the viewer tenant scope' },
        { status: 403 }
      );
    }
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
  return withViewerExecutionContext(resolvedViewer.context, () => {
    const resolved = resolveSafeRuntimeReferencePath(normalizedPath);
    if (!resolved) {
      return NextResponse.json({ error: `runtime ref not found: ${logicalPath}` }, { status: 404 });
    }
    return new NextResponse(safeReadFile(resolved, { encoding: 'utf8' }) as string, {
      headers: {
        'Content-Type': normalizedPath.endsWith('.json')
          ? 'application/json'
          : 'text/markdown; charset=utf-8',
      },
    });
  });
}
