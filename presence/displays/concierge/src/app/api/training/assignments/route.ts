import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { listTenantProfileSlugs } from '@agent/core/tenant-registry';
import { readTrainingAssignments, upsertTrainingAssignment } from '@agent/core/training-catalog';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { requireKnownRequestKeys, requireRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { resolveConciergeFrontDeskRole } from '../../../../lib/front-desk-member';

export const dynamic = 'force-dynamic';

function allowedTenant(viewer: { tenantSlugs: string[] | 'all' }, tenant: string): boolean {
  return viewer.tenantSlugs === 'all' || viewer.tenantSlugs.includes(tenant);
}

export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const tenants =
      resolved.context.tenantSlugs === 'all'
        ? withExecutionContext('sovereign_concierge', () => listTenantProfileSlugs())
        : resolved.context.tenantSlugs;
    const assignments = withExecutionContext('sovereign_concierge', () =>
      tenants.map((tenant_slug) => readTrainingAssignments(tenant_slug))
    );
    return NextResponse.json(
      { ok: true, assignments },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  if (resolveConciergeFrontDeskRole(resolved.context) !== 'owner') {
    return NextResponse.json(
      { ok: false, error: '組織の所有者だけが割り当てを変更できます。' },
      { status: 403 }
    );
  }
  try {
    const body = requireRequestObject(await req.json().catch(() => null), 'request body');
    requireKnownRequestKeys(body, ['tenant_slug', 'member_id', 'track_id']);
    const tenant = typeof body.tenant_slug === 'string' ? body.tenant_slug.trim() : '';
    const memberId = typeof body.member_id === 'string' ? body.member_id.trim() : '';
    const trackId = typeof body.track_id === 'string' ? body.track_id.trim() : '';
    if (!tenant || !memberId || !trackId || !allowedTenant(resolved.context, tenant)) {
      return NextResponse.json(
        { ok: false, error: '割り当ての入力を確認してください。' },
        { status: 400 }
      );
    }
    const assignments = withExecutionContext('sovereign_concierge', () =>
      upsertTrainingAssignment(tenant, memberId, trackId)
    );
    return NextResponse.json({ ok: true, assignments });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
