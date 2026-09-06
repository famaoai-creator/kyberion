import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { pathResolver } from '@agent/core/path-resolver';
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

function isAllowedKnowledgeRefPath(logicalPath: string): boolean {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized) return false;
  if (!/^knowledge\/(personal|confidential|public)\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.resolve('knowledge'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export function resolveSafeKnowledgeReferencePath(logicalPath: string): string | null {
  const normalized = normalizeScopedReadPath(logicalPath);
  if (!normalized || !isAllowedKnowledgeRefPath(normalized)) return null;
  try {
    const resolved = assertSafeRepositoryPath(pathResolver.resolve(normalized), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(resolved) && safeLstat(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const logicalPath = req.nextUrl.searchParams.get('path')?.trim() ?? '';
  if (!logicalPath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }
  const normalizedPath = normalizeScopedReadPath(logicalPath);
  if (!normalizedPath || !isAllowedKnowledgeRefPath(normalizedPath)) {
    return NextResponse.json(
      { error: `knowledge ref is not accessible: ${logicalPath}` },
      { status: 403 }
    );
  }
  const requestedTenant = req.nextUrl.searchParams.get('tenant') || undefined;
  let tenantSlugs: string[] | 'all';
  try {
    tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context, requestedTenant);
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
  const pathParts = normalizedPath.split('/');
  const pathTier = pathParts[1]?.toLowerCase();
  if (pathTier !== 'personal' && pathTier !== 'confidential' && pathTier !== 'public') {
    return NextResponse.json({ error: 'Knowledge ref has an invalid tier' }, { status: 403 });
  }
  try {
    strictViewerTier(resolvedViewer.context, pathTier);
  } catch (error) {
    return viewerErrorResponse(error, 403);
  }
  const pathTenant =
    pathTier === 'confidential' && pathParts[2] !== 'common' ? pathParts[2] : undefined;
  if (pathTenant && tenantSlugs !== 'all' && !tenantSlugs.includes(pathTenant)) {
    return NextResponse.json(
      { error: 'Knowledge ref is outside the viewer tenant scope' },
      { status: 403 }
    );
  }
  return withViewerExecutionContext(resolvedViewer.context, () => {
    const resolved = resolveSafeKnowledgeReferencePath(normalizedPath);
    if (!resolved) {
      return NextResponse.json(
        { error: `knowledge ref not found: ${logicalPath}` },
        { status: 404 }
      );
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
