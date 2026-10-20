import {
  resolveChronosWorkspace,
  workspaceSelectionFromSearchParams,
} from '../../../lib/workspace-scope';
import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { buildApprovalQueueItems } from '../../../lib/su-surface-data';
import { resolveViewerContextForRequest, viewerErrorResponse } from '../../../lib/viewer-context';
import { readChronosOptionalStringParam, readChronosStringParam } from '../../../lib/request-input';

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const resolvedViewer = resolveViewerContextForRequest(req);
  if (resolvedViewer.response) return resolvedViewer.response;

  try {
    const url = new URL(req.url);
    const workspace = resolveChronosWorkspace(
      resolvedViewer.context,
      workspaceSelectionFromSearchParams(req.nextUrl.searchParams)
    );
    const tenantSlugs = workspace.tenantSlugs;
    const requestId = readChronosOptionalStringParam(url.searchParams.get('requestId'));
    const storageChannel = readChronosOptionalStringParam(url.searchParams.get('storageChannel'));
    if (Boolean(requestId) !== Boolean(storageChannel))
      return NextResponse.json(
        { error: 'Exact approval selection requires requestId and storageChannel' },
        { status: 400 }
      );
    const approvals = buildApprovalQueueItems({
      requestId,
      storageChannel,
      viewer: resolvedViewer.context,
      workspace,
      query: readChronosOptionalStringParam(url.searchParams.get('query')),
      status: readChronosOptionalStringParam(url.searchParams.get('status')),
      kind: readChronosOptionalStringParam(url.searchParams.get('kind')),
      missionId: readChronosOptionalStringParam(url.searchParams.get('missionId')),
      tenant: readChronosOptionalStringParam(url.searchParams.get('tenant')),
      tenantSlugs,
      channel: readChronosOptionalStringParam(url.searchParams.get('channel')),
      limit: Number(readChronosStringParam(url.searchParams.get('limit')) || 24),
    });
    return NextResponse.json({
      approvals,
      accessRole: resolvedViewer.context.role,
      workspace: workspace.selection,
    });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
