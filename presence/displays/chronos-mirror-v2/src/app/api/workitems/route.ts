import { NextRequest, NextResponse } from 'next/server';
import {
  listWorkItems,
  getWorkItem,
  updateWorkItem,
} from '@agent/core/workforce/work-coordination';
import {
  buildWorkVisibilityProjection,
  type WorkVisibilityScope,
  type WorkVisibilityView,
} from '@agent/core/workforce/work-visibility';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds,
  ViewerContextError,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';
import {
  readChronosJsonObject,
  readChronosOptionalStringParam,
  readChronosStringParam,
} from '../../../lib/request-input';
import { requestWorkItemMissionAlignment, readWorkItemMissionAlignment } from './mission-alignment';
import { CHRONOS_WORK_ITEM_STATUSES, parseWorkItemActionInput } from './work-item-input';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
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
          tenantSlugs: tenantSlugs === 'all' ? undefined : tenantSlugs,
          organizationIds: organizationIds === 'all' ? undefined : organizationIds,
          projectIds: projectIds === 'all' ? undefined : projectIds,
        })
      ),
      viewer: { tenantSlugs, organizationIds, projectIds },
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
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  try {
    const parsedBody = await readChronosJsonObject(req, 'Chronos work items');
    if (parsedBody.ok !== true) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const input = parseWorkItemActionInput(parsedBody.body);
    const { itemId } = input;
    const current = withViewerExecutionContext(viewer, () => getWorkItem(itemId));
    if (!current)
      return NextResponse.json({ ok: false, error: 'work item not found' }, { status: 404 });
    const currentTenant =
      current.context?.tenant_slug ||
      (typeof current.metadata?.tenant_slug === 'string'
        ? current.metadata.tenant_slug
        : undefined);
    const currentOrganization =
      current.context?.organization_id ||
      (typeof current.metadata?.organization_id === 'string'
        ? current.metadata.organization_id
        : undefined);
    const currentProject = current.context?.project_id || current.project_id;
    if (
      viewer.tenantSlugs !== 'all' &&
      (!currentTenant || !viewer.tenantSlugs.includes(currentTenant))
    ) {
      throw new Error('viewer is not authorized for this work item tenant');
    }
    const organizationIds = strictViewerScopeOrganizationIds(viewer);
    if (
      organizationIds !== 'all' &&
      (!currentOrganization || !organizationIds.includes(currentOrganization))
    ) {
      throw new Error('viewer is not authorized for this work item organization');
    }
    const projectIds = strictViewerScopeProjectIds(viewer);
    if (projectIds !== 'all' && (!currentProject || !projectIds.includes(currentProject))) {
      throw new Error('viewer is not authorized for this work item project');
    }
    if ('action' in input) {
      if (
        !current.context?.tenant_slug ||
        current.metadata?.requested_work_shape !== 'mission' ||
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
      updateWorkItem({ itemId, status: input.status })
    );
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return viewerErrorResponse(
      error,
      error instanceof ViewerContextError ||
        (error instanceof Error && error.message.includes('not authorized'))
        ? 403
        : 500
    );
  }
}
