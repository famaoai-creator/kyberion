import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import { collectSystemStatus } from '../../../../lib/ops/system-status';
import {
  resolveOpsViewerForRequest,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';

/**
 * Aggregated system health (OP-04 Task 2): uptime, persisted provider
 * demotions, last-hour trace error rate, and a green/yellow/red rollup with
 * reasons. Contains operational detail, so it sits behind the standard
 * surface authentication (readonly access is enough).
 */
export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;

  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  return NextResponse.json(
    withViewerExecutionContext(resolvedViewer.context, () => collectSystemStatus())
  );
}
