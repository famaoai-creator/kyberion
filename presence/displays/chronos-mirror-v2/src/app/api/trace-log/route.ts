import { NextRequest, NextResponse } from 'next/server';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  filterTraceLogContent,
  isAllowedTraceLogPath,
  resolveSafeTraceLogPath,
} from '../../../lib/trace-log-access';
import { safeReadFile } from '@agent/core/secure-io';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import { readChronosStringParam } from '../../../lib/request-input';

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

  if (!isAllowedTraceLogPath(logicalPath)) {
    return NextResponse.json(
      { error: `trace log is not accessible: ${logicalPath}` },
      { status: 403 }
    );
  }
  const safeTracePath = resolveSafeTraceLogPath(logicalPath);
  if (!safeTracePath) {
    return NextResponse.json({ error: `trace log not found: ${logicalPath}` }, { status: 404 });
  }

  return withViewerExecutionContext(resolvedViewer.context, () => {
    const raw = safeReadFile(safeTracePath, { encoding: 'utf8' }) as string;
    const content = filterTraceLogContent(raw, safeTracePath, {
      tenantSlugs: resolvedViewer.context.tenantSlugs,
      tierAccess: resolvedViewer.context.tierAccess ?? ['public', 'confidential'],
    });
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  });
}
