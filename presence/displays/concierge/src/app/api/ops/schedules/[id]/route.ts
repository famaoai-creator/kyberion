import { NextRequest, NextResponse } from 'next/server';

import { guardOpsRequest, requireOpsAccess } from '../../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  strictViewerScopeTenantSlugs,
  viewerErrorResponse,
  withViewerExecutionContext,
} from '../../../../../lib/ops/ops-viewer';
import {
  findOpsSchedule,
  registerOpsSchedule,
  scheduleRunsCatalogPipeline,
  ScheduleInputError,
  toOpsScheduleView,
  unregisterOpsSchedule,
} from '../../../../../lib/ops/pipeline-schedules';
import { listOperatorExcludedSchedules } from '@agent/core/pipeline/pipeline-scheduler';
import { auditOpsMutation } from '../../../../../lib/ops/ops-audit';
import {
  opsViewerMayActRepositoryWide,
  REPOSITORY_WIDE_REFUSAL,
} from '../../../../../lib/ops/repository-wide-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

async function scheduleId(context: RouteContext): Promise<string> {
  const { id } = await context.params;
  return decodeURIComponent(id);
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const id = await scheduleId(context);
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
    const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context);
    const patch = body as Record<string, unknown>;
    const mayActRepositoryWide = opsViewerMayActRepositoryWide(resolvedViewer.context, req);
    const updated = withViewerExecutionContext(resolvedViewer.context, () => {
      const existing = findOpsSchedule(id, tenantSlugs);
      if (!existing) return null;
      // A catalog schedule — or a patch that points the schedule at a catalog
      // pipeline — is repository-wide; a tenant-floor schedule stays inside
      // the tenant scope that already admitted it.
      if (
        !mayActRepositoryWide &&
        (scheduleRunsCatalogPipeline(existing) || patch.pipelinePath !== undefined)
      ) {
        return 'refused' as const;
      }
      return registerOpsSchedule({ ...patch, id }, existing);
    });
    if (!updated) {
      return NextResponse.json({ ok: false, error: `Schedule not found: ${id}` }, { status: 404 });
    }
    if (updated === 'refused') {
      auditOpsMutation(resolvedViewer.context, 'concierge.schedule.update', 'failed', {
        schedule_id: id,
        refused: 'tenant_confined_viewer',
      });
      return NextResponse.json({ ok: false, error: REPOSITORY_WIDE_REFUSAL }, { status: 403 });
    }
    auditOpsMutation(resolvedViewer.context, 'concierge.schedule.update', 'completed', {
      schedule_id: id,
      enabled: updated.enabled,
    });
    return NextResponse.json({ ok: true, schedule: updated });
  } catch (error) {
    if (error instanceof ScheduleInputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    auditOpsMutation(
      resolvedViewer.context,
      'concierge.schedule.update',
      'failed',
      { schedule_id: id },
      error
    );
    return viewerErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const id = await scheduleId(context);
  const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context);
  const mayActRepositoryWide = opsViewerMayActRepositoryWide(resolvedViewer.context, req);
  const removed = withViewerExecutionContext(resolvedViewer.context, () => {
    const existing = findOpsSchedule(id, tenantSlugs);
    if (!existing) return false;
    // Removing a catalog schedule is as repository-wide as changing it.
    if (!mayActRepositoryWide && scheduleRunsCatalogPipeline(existing)) return 'refused' as const;
    return unregisterOpsSchedule(id, tenantSlugs);
  });
  if (removed === 'refused') {
    auditOpsMutation(resolvedViewer.context, 'concierge.schedule.unregister', 'failed', {
      schedule_id: id,
      refused: 'tenant_confined_viewer',
    });
    return NextResponse.json({ ok: false, error: REPOSITORY_WIDE_REFUSAL }, { status: 403 });
  }
  if (!removed) {
    return NextResponse.json({ ok: false, error: `Schedule not found: ${id}` }, { status: 404 });
  }
  auditOpsMutation(resolvedViewer.context, 'concierge.schedule.unregister', 'completed', {
    schedule_id: id,
  });
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest, context: RouteContext) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  const id = await scheduleId(context);
  const tenantSlugs = strictViewerScopeTenantSlugs(resolvedViewer.context);
  const schedule = withViewerExecutionContext(resolvedViewer.context, () => {
    const found = findOpsSchedule(id, tenantSlugs);
    if (!found) return null;
    const excluded = listOperatorExcludedSchedules([found]);
    return toOpsScheduleView(found, excluded);
  });
  if (!schedule) {
    return NextResponse.json({ ok: false, error: `Schedule not found: ${id}` }, { status: 404 });
  }
  return NextResponse.json({ schedule });
}
