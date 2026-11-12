import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import {
  listOpsSchedules,
  registerOpsSchedule,
  ScheduleInputError,
} from '../../../../lib/ops/pipeline-schedules';
import { auditOpsMutation } from '../../../../lib/ops/ops-audit';
import {
  opsViewerMayActRepositoryWide,
  REPOSITORY_WIDE_REFUSAL,
} from '../../../../lib/ops/repository-wide-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context);
  const schedules = withViewerExecutionContext(resolvedViewer.context, () =>
    listOpsSchedules(new Date(), tenantSlugs)
  );
  return NextResponse.json({ schedules, accessRole: resolvedViewer.context.role });
}

export async function POST(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  // A schedule registered here always points at a catalog pipeline.
  if (!opsViewerMayActRepositoryWide(resolvedViewer.context, req)) {
    auditOpsMutation(resolvedViewer.context, 'concierge.schedule.register', 'failed', {
      refused: 'tenant_confined_viewer',
    });
    return NextResponse.json({ ok: false, error: REPOSITORY_WIDE_REFUSAL }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: 'Body must be an object.' }, { status: 400 });
  }

  try {
    const schedule = withViewerExecutionContext(resolvedViewer.context, () =>
      registerOpsSchedule(body as Record<string, unknown>)
    );
    auditOpsMutation(resolvedViewer.context, 'concierge.schedule.register', 'completed', {
      schedule_id: schedule.id,
      pipeline_path: schedule.pipelinePath,
    });
    return NextResponse.json({ ok: true, schedule });
  } catch (error) {
    if (error instanceof ScheduleInputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    auditOpsMutation(
      resolvedViewer.context,
      'concierge.schedule.register',
      'failed',
      undefined,
      error
    );
    return viewerErrorResponse(error);
  }
}
