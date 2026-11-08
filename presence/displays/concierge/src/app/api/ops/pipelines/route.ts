import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import { listPipelineCatalog } from '../../../../lib/ops/pipeline-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The runnable ADF catalog — the pipelines/ tree's .json files minus shared fragments. */
export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const pipelines = withViewerExecutionContext(resolvedViewer.context, () => listPipelineCatalog());
  return NextResponse.json({ pipelines, accessRole: resolvedViewer.context.role });
}
