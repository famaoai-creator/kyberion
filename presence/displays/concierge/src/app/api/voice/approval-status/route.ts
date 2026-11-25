import { NextRequest, NextResponse } from 'next/server';
import {
  isApprovalRequestExpired,
  normalizeApprovalRequestId,
} from '@agent/core/governance/approval-store-reader';
import { loadConciergeApproval } from '../../../../lib/personal-approval-server';
import { requireConciergeInstallationAccess } from '../../../../lib/installation-access';
import {
  conciergeErrorResponse,
  resolveConciergeViewer,
  withConciergeViewerContext,
} from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const viewer = resolved.context;
  const gate = requireConciergeInstallationAccess(viewer, 'read', req, 'voice approval status');
  if (gate.response) return gate.response;
  let id: string;
  try {
    id = normalizeApprovalRequestId(req.nextUrl.searchParams.get('id') ?? '');
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }
  try {
    const approval = withConciergeViewerContext(viewer, () =>
      loadConciergeApproval(viewer, 'external-operation', id)
    );
    const scope = approval?.scope;
    const operation = approval?.accountability?.effectBinding;
    if (
      !approval ||
      !scope ||
      scope.tenant_slug ||
      scope.organization_id ||
      scope.project_id ||
      scope.mission_id ||
      scope.task_id ||
      scope.session_id ||
      !['personal', 'public'].includes(scope.tier) ||
      !viewer.tierAccess.includes(scope.tier) ||
      (operation !== 'voice:speak' && operation !== 'voice:playback')
    )
      return NextResponse.json({ ok: false }, { status: 404, headers });
    const status = approval.revocation
      ? 'revoked'
      : isApprovalRequestExpired(approval)
        ? 'expired'
        : approval.status;
    return NextResponse.json({ ok: true, id, status }, { headers });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
