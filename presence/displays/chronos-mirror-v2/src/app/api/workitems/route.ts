import { NextRequest, NextResponse } from 'next/server';
import {
  listWorkItems,
  getWorkItem,
  updateWorkItem,
  type WorkItemStatus,
} from '@agent/core/work-coordination';
import {
  buildWorkVisibilityProjection,
  type WorkVisibilityScope,
  type WorkVisibilityView,
} from '@agent/core/work-visibility';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
  ViewerContextError,
  withViewerExecutionContext,
} from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

const KANBAN_STATUSES: WorkItemStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'review',
  'done',
  'archived',
];

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;
  const viewer = resolvedViewer.context;
  const rawScope = req.nextUrl.searchParams.get('scope') || 'work_items';
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
  const rawView = req.nextUrl.searchParams.get('view') || 'all';
  const view: WorkVisibilityView = ['all', 'actionable', 'active', 'history'].includes(rawView)
    ? (rawView as WorkVisibilityView)
    : 'all';
  try {
    const tenantSlugs = strictViewerScopeTenantSlugs(
      viewer,
      req.nextUrl.searchParams.get('tenant') || undefined
    );
    const projection = buildWorkVisibilityProjection({
      items: withViewerExecutionContext(viewer, () =>
        listWorkItems({ tenantSlugs: tenantSlugs === 'all' ? undefined : tenantSlugs })
      ),
      viewer: { tenantSlugs },
      scope,
      view,
      organizationId: req.nextUrl.searchParams.get('organization_id') || undefined,
      missionId: req.nextUrl.searchParams.get('mission_id') || undefined,
      projectId: req.nextUrl.searchParams.get('project_id') || undefined,
    });
    return NextResponse.json({
      ok: true,
      statuses: KANBAN_STATUSES,
      scope: projection.scope,
      view: projection.view,
      items: projection.items,
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
    const body = await req.json();
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const status = KANBAN_STATUSES.includes(body?.status) ? (body.status as WorkItemStatus) : null;
    if (!itemId || !status) {
      return NextResponse.json(
        { ok: false, error: 'itemId と status が必要です' },
        { status: 400 }
      );
    }
    const current = withViewerExecutionContext(viewer, () => getWorkItem(itemId));
    if (!current)
      return NextResponse.json({ ok: false, error: 'work item not found' }, { status: 404 });
    const currentTenant =
      current.context?.tenant_slug ||
      (typeof current.metadata?.tenant_slug === 'string'
        ? current.metadata.tenant_slug
        : undefined);
    if (
      viewer.tenantSlugs !== 'all' &&
      (!currentTenant || !viewer.tenantSlugs.includes(currentTenant))
    ) {
      throw new Error('viewer is not authorized for this work item tenant');
    }
    const updated = withViewerExecutionContext(viewer, () => updateWorkItem({ itemId, status }));
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      {
        status:
          error instanceof ViewerContextError ||
          (error instanceof Error && error.message.includes('not authorized'))
            ? 403
            : 500,
      }
    );
  }
}
