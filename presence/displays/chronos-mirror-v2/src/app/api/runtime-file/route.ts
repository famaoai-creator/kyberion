import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { safeReadFile } from '@agent/core/secure-io';
import {
  resolveViewerContextForRequest,
  strictViewerTier,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { normalizeScopedReadPath } from '../../../lib/scoped-read-path';
import { readChronosStringParam } from '../../../lib/request-input';
import {
  isAllowedRuntimeRefPath,
  resolveRuntimeReferenceScope,
  resolveSafeRuntimeReferencePath,
} from './helpers';

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const logicalPath = readChronosStringParam(req.nextUrl.searchParams.get('path'));
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
