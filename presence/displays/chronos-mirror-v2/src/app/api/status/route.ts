import { NextRequest, NextResponse } from 'next/server';

import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { collectSystemStatus } from '../../../lib/system-status';
import {
  resolveViewerContextForRequest,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

/**
 * Aggregated system health (OP-04 Task 2): uptime, persisted provider
 * demotions, last-hour trace error rate, and a green/yellow/red rollup with
 * reasons. Contains operational detail, so it sits behind the standard
 * surface authentication (readonly access is enough).
 */
export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;

  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  return NextResponse.json(
    withViewerExecutionContext(resolvedViewer.context, () => collectSystemStatus())
  );
}
