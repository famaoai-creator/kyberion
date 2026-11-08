import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/ops/ops-viewer';
import { dispatchPipelineRun, PipelineRunError } from '../../../../../lib/ops/pipeline-run';
import { auditOpsMutation } from '../../../../../lib/ops/ops-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Execute one catalog ADF (a `pipelines/` tree .json file) as a detached
 * governed child. The response carries the managed-process resource id; run
 * progress is recorded by the pipeline run journal, not by this route.
 */
export async function POST(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON.' }, { status: 400 });
  }
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const pipelinePath = typeof input.pipelinePath === 'string' ? input.pipelinePath : '';
  if (!pipelinePath.trim()) {
    return NextResponse.json({ ok: false, error: 'pipelinePath is required.' }, { status: 400 });
  }
  const context =
    input.context && typeof input.context === 'object' && !Array.isArray(input.context)
      ? (input.context as Record<string, unknown>)
      : undefined;

  try {
    const dispatch = withViewerExecutionContext(resolvedViewer.context, () =>
      dispatchPipelineRun({
        pipelinePath,
        ...(context ? { context } : {}),
        label: 'concierge:catalog',
      })
    );
    auditOpsMutation(resolvedViewer.context, 'concierge.pipeline.run', 'completed', {
      resource_id: dispatch.resourceId,
      pipeline_path: dispatch.pipelinePath,
    });
    return NextResponse.json({ ok: true, run: dispatch });
  } catch (error) {
    if (error instanceof PipelineRunError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    auditOpsMutation(
      resolvedViewer.context,
      'concierge.pipeline.run',
      'failed',
      { pipeline_path: pipelinePath },
      error
    );
    return viewerErrorResponse(error);
  }
}
