import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  filterTraceLogContent,
  isAllowedTraceLogPath,
  resolveSafeTraceLogPath,
} from '../../../../lib/ops/trace-log-access';
import { safeReadFile } from '@agent/core/secure-io';
import {
  resolveOpsViewerForRequest,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import { readChronosStringParam } from '../../../../lib/ops/request-input';

export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;

  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
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
