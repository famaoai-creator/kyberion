import { NextRequest, NextResponse } from 'next/server';
import {
  listWorkItems,
  getWorkItem,
  updateWorkItem,
} from '@agent/core/workforce/work-coordination';
import {
  buildWorkVisibilityProjection,
  workItemVisibleToViewer,
  type WorkVisibilityScope,
  type WorkVisibilityView,
} from '@agent/core/workforce/work-visibility';
import { invalidateWorkspaceGraphCache } from '@agent/core/surface/surface-operation-registry';
import { guardOpsRequest, requireOpsAccess } from '../../../../lib/ops/ops-request-guard';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  ViewerContextError,
  withViewerExecutionContext,
} from '../../../../lib/ops/ops-viewer';
import {
  readChronosJsonObject,
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../../lib/ops/request-input';
import { requestWorkItemMissionAlignment, readWorkItemMissionAlignment } from './mission-alignment';
import { requestedExecutionShape } from '@agent/core/dot/dot-action-ledger';
import { CHRONOS_WORK_ITEM_STATUSES, parseWorkItemActionInput } from './work-item-input';

export const dynamic = 'force-dynamic';

function isWorkItemValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'WorkCoordinationError' &&
    (error as Error & { code?: unknown }).code === 'validation_error'
  );
}

export function GET(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  const rawScope = readChronosStringParam(req.nextUrl.searchParams.get('scope')) || 'work_items';
  const scope: WorkVisibilityScope = [
    'organization',
    'home',
    'work_items',
    'operations',
    'missions',
    'governance',
  ].includes(rawScope)
    ? (rawScope as WorkVisibilityScope)
    : 'work_items';
  const rawView = readChronosStringParam(req.nextUrl.searchParams.get('view')) || 'all';
  const view: WorkVisibilityView = ['all', 'actionable', 'active', 'history'].includes(rawView)
    ? (rawView as WorkVisibilityView)
    : 'all';
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(
      viewer,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('tenant'))
    );
    const organizationIds = strictViewerScopeOrganizationIds(
      viewer,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('organization_id'))
    );
    const projectIds = strictViewerScopeProjectIds(
      viewer,
      readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id'))
    );
    const projection = buildWorkVisibilityProjection({
      items: withViewerExecutionContext(viewer, () =>
        listWorkItems({
          tenantSlugs:
            tenantSlugs === 'all' || (viewer.includeUntenanted && tenantSlugs.length === 0)
              ? undefined
              : tenantSlugs,
          organizationIds:
            organizationIds === 'all' || (viewer.includeUntenanted && organizationIds.length === 0)
              ? undefined
              : organizationIds,
          projectIds:
            projectIds === 'all' || (viewer.includeUntenanted && projectIds.length === 0)
              ? undefined
              : projectIds,
        })
      ),
      viewer: { ...viewer, tenantSlugs, organizationIds, projectIds },
      scope,
      view,
      organizationId: readChronosOptionalStringParam(
        req.nextUrl.searchParams.get('organization_id')
      ),
      missionId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('mission_id')),
      projectId: readChronosOptionalStringParam(req.nextUrl.searchParams.get('project_id')),
    });
    return NextResponse.json({
      ok: true,
      // Lets the board hide move controls from readonly viewers; POST stays the gate.
      accessRole: viewer.role,
      statuses: CHRONOS_WORK_ITEM_STATUSES,
      scope: projection.scope,
      view: projection.view,
      items: projection.items.map((rawItem) => {
        const metadata = { ...rawItem.metadata };
        delete metadata.mission_alignment_decision;
        const item = { ...rawItem, metadata };
        if (!item.metadata?.mission_alignment_preparation) return item;
        try {
          const current = withViewerExecutionContext(viewer, () => getWorkItem(item.item_id));
          if (
            !current ||
            !workItemVisibleToViewer(current, viewer) ||
            current.context?.tenant_slug !== item.context?.tenant_slug ||
            current.context?.organization_id !== item.context?.organization_id ||
            current.context?.project_id !== item.context?.project_id
          )
            return item;
          const receipt = readWorkItemMissionAlignment(current);
          return {
            ...item,
            metadata: { ...item.metadata, mission_alignment_decision: receipt.admission },
          };
        } catch {
          return item;
        }
      }),
      counts: projection.counts,
      quality: projection.quality,
      lineage: projection.lineage,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const requiresAccess = requireOpsAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const parsedBody = await readChronosJsonObject(req, 'Chronos work items');
    if (parsedBody.ok !== true) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    let input: ReturnType<typeof parseWorkItemActionInput>;
    try {
      input = parseWorkItemActionInput(parsedBody.body);
    } catch {
      // A malformed body is the caller's mistake, never a server fault.
      return NextResponse.json(
        { ok: false, error: 'invalid work item request', error_code: 'invalid_input' },
        { status: 400 }
      );
    }
    const { itemId } = input;
    const current = withViewerExecutionContext(viewer, () => getWorkItem(itemId));
    if (!current)
      return NextResponse.json({ ok: false, error: 'work item not found' }, { status: 404 });
    if (
      !workItemVisibleToViewer(current, {
        ...viewer,
        organizationIds: strictViewerScopeOrganizationIds(viewer),
        projectIds: strictViewerScopeProjectIds(viewer),
      })
    )
      throw new Error('viewer is not authorized for this work item custody');
    if ('action' in input) {
      if (
        !current.context?.tenant_slug ||
        requestedExecutionShape(current.metadata) !== 'mission' ||
        current.metadata?.admission_only !== true ||
        !['ready', 'blocked'].includes(current.status)
      )
        return NextResponse.json(
          { ok: false, error: 'only a held typed mission intake can request alignment' },
          { status: 409 }
        );
      const result = await requestWorkItemMissionAlignment(current);
      return NextResponse.json({ ok: true, ...result });
    }
    const updated = withViewerExecutionContext(viewer, () =>
      'status' in input
        ? updateWorkItem({ itemId, status: input.status })
        : updateWorkItem({
            itemId,
            ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
            ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
          })
    );
    // The workspace graph (/w boards) caches its join briefly; a move must show at once.
    invalidateWorkspaceGraphCache();
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    // The store refuses an impossible change (e.g. a due date before the start date).
    if (isWorkItemValidationError(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'the work item store refused this change as invalid',
          error_code: 'invalid_change',
        },
        { status: 400 }
      );
    }
    return viewerErrorResponse(
      error,
      error instanceof ViewerContextError ||
        (error instanceof Error && error.message.includes('not authorized'))
        ? 403
        : 500
    );
  }
}
