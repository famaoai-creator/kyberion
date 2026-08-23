import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../../../../lib/api-guard';
import { headlessEnvelope } from '../../../../../../lib/headless-response';
import { updateHeadlessWorkItemStatus } from '../../../../../../lib/headless-projections';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
} from '../../../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const access = requireChronosAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const body = await req.json();
    const item = updateHeadlessWorkItemStatus(resolvedViewer.context, {
      itemId: body?.item_id,
      status: body?.status,
    });
    return NextResponse.json(
      headlessEnvelope(
        'work-items',
        { operation_id: 'chronos.work_items.update_status', item },
        resolvedViewer.context
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.includes('not authorized')
      ? 403
      : message === 'work item not found'
        ? 404
        : 400;
    return viewerErrorResponse(error, status);
  }
}
