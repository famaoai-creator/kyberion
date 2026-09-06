import { NextRequest, NextResponse } from 'next/server';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';
import { buildApprovalQueueItems } from '../../../lib/su-surface-data';
import {
  resolveViewerContextForRequest,
  viewerErrorResponse,
  strictViewerScopeTenantSlugs,
} from '../../../lib/viewer-context';
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
    const tenantSlugs = strictViewerScopeTenantSlugs(
      resolvedViewer.context,
      readChronosOptionalStringParam(url.searchParams.get('tenant'))
    );
    const approvals = buildApprovalQueueItems({
      query: readChronosOptionalStringParam(url.searchParams.get('query')),
      status: readChronosOptionalStringParam(url.searchParams.get('status')),
      kind: readChronosOptionalStringParam(url.searchParams.get('kind')),
      missionId: readChronosOptionalStringParam(url.searchParams.get('missionId')),
      tenant: readChronosOptionalStringParam(url.searchParams.get('tenant')),
      tenantSlugs,
      channel: readChronosOptionalStringParam(url.searchParams.get('channel')),
      limit: Number(readChronosStringParam(url.searchParams.get('limit')) || 24),
    });
    return NextResponse.json({ approvals, accessRole: resolvedViewer.context.role });
  } catch (error) {
    return viewerErrorResponse(error);
  }
}
