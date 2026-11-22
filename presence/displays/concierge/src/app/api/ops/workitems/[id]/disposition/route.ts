import { NextRequest, NextResponse } from 'next/server';
import {
  applyWorkflowDisposition,
  isWorkflowDisposition,
} from '@agent/core/workforce/workflow-disposition';
import { getWorkItem, WorkCoordinationError } from '@agent/core/workforce/work-coordination';
import { workItemVisibleToViewer } from '@agent/core/workforce/work-visibility';
import { guardOpsRequest, requireOpsAccess } from '../../../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  withViewerExecutionContext,
} from '../../../../../../lib/ops/ops-viewer';
import { readChronosJsonObject } from '../../../../../../lib/ops/request-input';
import {
  conciergeDecisionDenied,
  resolveConciergeDecidedBy,
} from '../../../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

/**
 * PB-03: durable workflow disposition for a blocked/review WorkItem.
 * Surfaces never settle disposition through approval-store binary decide.
 * Authz mirrors other /api/ops/workitems mutations (viewer + decision role).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;

  try {
    const { id } = await context.params;
    const parsed = await readChronosJsonObject(req, 'workflow disposition');
    if (parsed.ok !== true) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
    }
    const disposition = parsed.body?.disposition;
    if (!id || !isWorkflowDisposition(disposition)) {
      return NextResponse.json(
        { ok: false, error: 'disposition must be retry|skip|reassign|accept' },
        { status: 400 }
      );
    }

    const current = withViewerExecutionContext(viewer, () => getWorkItem(id));
    if (!current) {
      return NextResponse.json({ ok: false, error: 'work item not found' }, { status: 404 });
    }
    if (
      !workItemVisibleToViewer(current, {
        ...viewer,
        organizationIds: strictViewerScopeOrganizationIds(viewer),
        projectIds: strictViewerScopeProjectIds(viewer),
      })
    ) {
      return NextResponse.json(
        { ok: false, error: 'viewer is not authorized for this work item' },
        { status: 403 }
      );
    }

    const resourceTenant = current.context?.tenant_slug;
    const decisionDenied = conciergeDecisionDenied(viewer, resourceTenant);
    if (decisionDenied) return decisionDenied;
    const decider = resolveConciergeDecidedBy(viewer, resourceTenant);
    if (!decider?.role || viewer.principal?.actor.kind !== 'human') {
      return NextResponse.json(
        {
          ok: false,
          code: 'WORKFLOW_DECIDER_REQUIRED',
          error: 'An authenticated decision-capable member is required.',
        },
        { status: 403 }
      );
    }

    const newOwnerId =
      typeof parsed.body?.newOwnerId === 'string' ? parsed.body.newOwnerId.trim() : '';
    if (disposition === 'reassign' && !newOwnerId) {
      return NextResponse.json(
        { ok: false, error: 'reassign requires newOwnerId' },
        { status: 400 }
      );
    }

    const note = typeof parsed.body?.note === 'string' ? parsed.body.note : undefined;
    const result = withViewerExecutionContext(viewer, () =>
      applyWorkflowDisposition({
        itemId: id,
        disposition,
        actorId: decider.id,
        ...(newOwnerId ? { newOwnerId } : {}),
        ...(note ? { note } : {}),
        expectedVersion: current.version,
      })
    );
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof WorkCoordinationError) {
      const statuses: Partial<Record<WorkCoordinationError['code'], number>> = {
        version_conflict: 409,
        lease_conflict: 409,
        validation_error: 400,
      };
      const status = statuses[error.code];
      if (status)
        return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('[POLICY_VIOLATION]')) {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    return viewerErrorResponse(error);
  }
}
