import { NextRequest, NextResponse } from 'next/server';
import {
  isValidMemberId,
  type MemberExternalIdentity,
  type MemberRole,
} from '@agent/core/organization/member-registry';
import {
  managedMemberVersion,
  updateManagedMember,
} from '@agent/core/organization/member-management';
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import {
  RequestInputError,
  requireKnownRequestKeys,
  requireRequestObject,
} from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  memberManagementPrincipal,
  assertMemberManagementContext,
} from '../../../../lib/member-management-server';

export const dynamic = 'force-dynamic';

function externalIdentity(value: unknown, email: boolean): MemberExternalIdentity | undefined {
  if (value === undefined) return undefined;
  const record = requireRequestObject(value, 'external identity');
  requireKnownRequestKeys(record, email ? ['issuer', 'subject', 'email'] : ['issuer', 'subject']);
  if (
    typeof record.issuer !== 'string' ||
    typeof record.subject !== 'string' ||
    (record.email !== undefined && typeof record.email !== 'string')
  )
    throw new SurfaceManagementError('invalid_identity', 400, 'Issuer and subject must be text.');
  return {
    issuer: record.issuer,
    subject: record.subject,
    ...(typeof record.email === 'string' ? { email: record.email } : {}),
  };
}

/** Shared core service owns tenant authorization, last-owner checks and persistence. */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const viewer = resolveConciergeViewer(req);
  if (viewer.response) return viewer.response;
  try {
    const { id } = await context.params;
    if (!isValidMemberId(id))
      throw new SurfaceManagementError('invalid_member', 400, 'Invalid member id.');
    const body = requireRequestObject(await req.json().catch(() => null), 'request body');
    requireKnownRequestKeys(body, [
      'tenant_slug',
      'role',
      'status',
      'display_name',
      'membership_remove',
      'external_identity',
      'external_identity_remove',
      'expected_version',
      'expected_context_id',
    ]);
    for (const key of [
      'tenant_slug',
      'role',
      'status',
      'display_name',
      'membership_remove',
      'expected_version',
    ])
      if (body[key] !== undefined && typeof body[key] !== 'string')
        throw new SurfaceManagementError('invalid_member', 400, `${key} must be text.`);
    const principal = memberManagementPrincipal(viewer.context);
    assertMemberManagementContext(viewer.context, body.expected_context_id, principal);
    const updated = await updateManagedMember(principal, {
      memberId: id,
      ...(body.tenant_slug !== undefined ? { tenantSlug: body.tenant_slug as string } : {}),
      ...(body.role !== undefined ? { role: body.role as MemberRole } : {}),
      ...(body.status !== undefined ? { status: body.status as 'active' | 'suspended' } : {}),
      ...(body.display_name !== undefined ? { displayName: body.display_name as string } : {}),
      ...(body.membership_remove !== undefined
        ? { removeTenantSlug: body.membership_remove as string }
        : {}),
      ...(body.expected_version !== undefined
        ? { expectedVersion: body.expected_version as string }
        : {}),
      ...(body.external_identity !== undefined
        ? { externalIdentity: externalIdentity(body.external_identity, true) }
        : {}),
      ...(body.external_identity_remove !== undefined
        ? { removeExternalIdentity: externalIdentity(body.external_identity_remove, false) }
        : {}),
    });
    return NextResponse.json({ ok: true, version: managedMemberVersion(updated) });
  } catch (error) {
    if (error instanceof RequestInputError)
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    if (error instanceof SurfaceManagementError)
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status }
      );
    if (error instanceof Error && /already bound to member/.test(error.message))
      return NextResponse.json(
        { ok: false, error: 'This external identity is already bound to another member.' },
        { status: 409 }
      );
    return conciergeErrorResponse(error, 500);
  }
}
