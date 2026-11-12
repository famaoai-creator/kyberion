import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../../lib/ops/ops-viewer';
import {
  findOpsSchedule,
  scheduleRunsCatalogPipeline,
} from '../../../../../../lib/ops/pipeline-schedules';
import { dispatchPipelineRun, PipelineRunError } from '../../../../../../lib/ops/pipeline-run';
import { auditOpsMutation } from '../../../../../../lib/ops/ops-audit';
import {
  opsViewerMayActRepositoryWide,
  REPOSITORY_WIDE_REFUSAL,
} from '../../../../../../lib/ops/repository-wide-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Run one scheduled pipeline immediately — detached governed child, audited. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const { id } = await context.params;
  const scheduleId = decodeURIComponent(id);
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context);
    const mayActRepositoryWide = opsViewerMayActRepositoryWide(resolvedViewer.context, req);
    const dispatch = withViewerExecutionContext(resolvedViewer.context, () => {
      const schedule = findOpsSchedule(scheduleId, tenantSlugs);
      if (!schedule) return null;
      if (!mayActRepositoryWide && scheduleRunsCatalogPipeline(schedule)) return 'refused' as const;
      return dispatchPipelineRun({
        pipelinePath: schedule.pipelinePath,
        ...(schedule.context ? { context: schedule.context } : {}),
        label: `schedule:${schedule.id}`,
      });
    });
    if (!dispatch) {
      return NextResponse.json(
        { ok: false, error: `Schedule not found: ${scheduleId}` },
        { status: 404 }
      );
    }
    if (dispatch === 'refused') {
      auditOpsMutation(resolvedViewer.context, 'concierge.schedule.run_now', 'failed', {
        schedule_id: scheduleId,
        refused: 'tenant_confined_viewer',
      });
      return NextResponse.json({ ok: false, error: REPOSITORY_WIDE_REFUSAL }, { status: 403 });
    }
    auditOpsMutation(resolvedViewer.context, 'concierge.schedule.run_now', 'completed', {
      schedule_id: scheduleId,
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
      'concierge.schedule.run_now',
      'failed',
      { schedule_id: scheduleId },
      error
    );
    return viewerErrorResponse(error);
  }
}
