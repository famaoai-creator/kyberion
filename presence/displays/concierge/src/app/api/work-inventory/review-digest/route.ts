import { NextResponse, type NextRequest } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { listObservationSummaries } from '@agent/core/workforce/work-inventory-observation';
import { listWorkInventoryConsents } from '@agent/core/workforce/work-inventory-consent';
import { nowIso } from '@agent/core/foundation/time';
import { buildObservationReview } from '../../../../lib/observation-review';
import { requireWorkInventoryMember } from '../../../../lib/work-inventory-member';
import { resolveConciergeSelectedViewer } from '../../../../lib/selected-tenant';
import { conciergeErrorResponse, narrowConciergeScope } from '../../../../lib/viewer-context';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

/**
 * Read-only, subject-owned counts for the company named by `?tenant=`, which
 * must also be the server-validated selection; client parameters can only
 * narrow server scope.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) {
    resolved.response.headers.set('Cache-Control', 'no-store');
    return resolved.response;
  }
  const viewer = resolved.viewer;
  if (viewer.source === 'anonymous' || !viewer.principalId) {
    return NextResponse.json(
      { ok: false, error_code: 'identity_required' },
      { status: 401, headers }
    );
  }
  const member = requireWorkInventoryMember(req, viewer);
  if (member.response) {
    member.response.headers.set('Cache-Control', 'no-store');
    return member.response;
  }
  try {
    // The company must be requested explicitly and accepted as the selection.
    const tenant =
      resolved.selection.mode === 'tenant' && resolved.selection.source === 'url'
        ? resolved.selection.tenant_slug
        : null;
    // Records have no organization/project attribution: restricted viewers cannot read them.
    if (
      !tenant ||
      viewer.organizationIds !== 'all' ||
      viewer.projectIds !== 'all' ||
      !viewer.tierAccess.includes('confidential') ||
      member.member.status !== 'active' ||
      !member.member.memberships.some((entry) => entry.tenant_slug === tenant)
    ) {
      return NextResponse.json(
        { ok: false, error_code: 'review_scope_required' },
        { status: 403, headers }
      );
    }
    narrowConciergeScope(viewer, { tenant });
    const digest = withExecutionContext('sovereign_concierge', () =>
      buildObservationReview(
        listObservationSummaries(member.member.member_id),
        listWorkInventoryConsents(member.member.member_id),
        member.member.member_id,
        tenant,
        new Date(nowIso())
      )
    );
    return NextResponse.json({ ok: true, ...digest }, { headers });
  } catch (error) {
    const response = conciergeErrorResponse(error);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
