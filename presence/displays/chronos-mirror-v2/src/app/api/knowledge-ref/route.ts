import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import {
  resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

function isAllowedKnowledgeRefPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || '').replace(/^\/+/, '');
  if (!/^knowledge\/(personal|confidential|public)\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.resolve('knowledge'));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
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
  if (!isAllowedKnowledgeRefPath(logicalPath)) {
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
  const pathParts = logicalPath.split('/');
  const pathTenant =
    pathParts[1] === 'confidential' && pathParts[2] !== 'common' ? pathParts[2] : undefined;
  if (pathTenant && tenantSlugs !== 'all' && !tenantSlugs.includes(pathTenant)) {
    return NextResponse.json(
      { error: 'Knowledge ref is outside the viewer tenant scope' },
      { status: 403 }
    );
  }
  return withViewerExecutionContext(resolvedViewer.context, () => {
    const resolved = pathResolver.resolve(logicalPath);
    if (!safeExistsSync(resolved)) {
      return NextResponse.json(
        { error: `knowledge ref not found: ${logicalPath}` },
        { status: 404 }
      );
    }
    return new NextResponse(safeReadFile(resolved, { encoding: 'utf8' }) as string, {
      headers: {
        'Content-Type': logicalPath.endsWith('.json')
          ? 'application/json'
          : 'text/markdown; charset=utf-8',
      },
    });
  });
}
