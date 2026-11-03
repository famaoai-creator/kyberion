import { NextRequest, NextResponse } from 'next/server';
import { guardOpsRequest, requireOpsAccess } from '../../../../../../../lib/ops/ops-request-guard';
import {
  authorizeHeadlessOperation,
  headlessEnvelope,
} from '../../../../../../../lib/ops/headless-response';
import { updateHeadlessWorkItemStatus } from '../../../../../../../lib/ops/headless-projections';
import {
  resolveOpsViewerForRequest,
  viewerErrorResponse,
} from '../../../../../../../lib/ops/ops-viewer';
import { readChronosJsonObject } from '../../../../../../../lib/ops/request-input';
import { parseHeadlessWorkItemStatusInput } from './status-input';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = guardOpsRequest(req);
  if (denied) return denied;
  const access = requireOpsAccess(req, 'localadmin');
  if (access) return access;
  const resolvedViewer = resolveOpsViewerForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const parsedBody = await readChronosJsonObject(req, 'Chronos headless work items');
    if (parsedBody.ok !== true)
      return NextResponse.json({ error: parsedBody.error }, { status: 400 });
    const input = parseHeadlessWorkItemStatusInput(parsedBody.body);
    authorizeHeadlessOperation(resolvedViewer.context, 'chronos.work_items.update_status');
    const item = updateHeadlessWorkItemStatus(resolvedViewer.context, {
      itemId: input.item_id,
      status: input.status,
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
