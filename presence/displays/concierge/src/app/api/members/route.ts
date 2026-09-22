import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso } from '@agent/core/foundation';
import {
  issueChronosAccessToken,
  type ChronosAccessRole,
} from '@agent/core/chronos-access-registry';
import { frontDeskRoleAuthority, type FrontDeskHumanRole } from '@agent/core/front-desk-roles';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  isValidMemberId,
  listMemberIds,
  readMemberProfile,
  writeMemberProfile,
  type MemberProfile,
} from '@agent/core/member-registry';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { requireKnownRequestKeys, requireRequestObject } from '../../../lib/request-input';
import {
  conciergeErrorResponse,
  resolveConciergeViewer,
  type ConciergeViewerContext,
} from '../../../lib/viewer-context';
import { conciergeFrontDeskRoleForTenant } from '../../../lib/front-desk-member';
import { frontDeskText, resolveConciergeLocale } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

const HUMAN_ROLES: readonly FrontDeskHumanRole[] = ['owner', 'approver', 'operator', 'viewer'];

function isHumanRole(value: unknown): value is FrontDeskHumanRole {
  return typeof value === 'string' && (HUMAN_ROLES as readonly string[]).includes(value);
}

interface MemberListItem {
  member_id: string;
  display_name: string;
  status: MemberProfile['status'];
  /** Derived: a member with any access_registrations signs in with a token; otherwise (only ever the owner) locally. */
  sign_in: 'local' | 'token';
  memberships: MemberProfile['memberships'];
}

function toListItem(profile: MemberProfile): MemberListItem {
  return {
    member_id: profile.member_id,
    display_name: profile.display_name,
    status: profile.status,
    sign_in: profile.access_registrations.length > 0 ? 'token' : 'local',
    memberships: profile.memberships,
  };
}

function requireViewer(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  return resolveConciergeViewer(req);
}

/** FD-07 「設定 › 組織とメンバー」member list. Any authenticated viewer may read it — the settings nav item itself already gates to owner. */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const members = withExecutionContext('sovereign_concierge', () =>
      listMemberIds()
        .map((memberId) => readMemberProfile(memberId))
        .filter((profile): profile is MemberProfile => profile !== null)
        .map(toListItem)
    );
    return NextResponse.json({ ok: true, members }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

/**
 * FD-07 「メンバーを追加」: owner-only. Creates the member record and,
 * when `issue_token` is set, a chronos-access registration bound to the new
 * member (`issueChronosAccessToken`) — the raw token is returned exactly
 * once in this response and is never persisted or logged in plaintext.
 */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const viewer = requireViewer(req);
  if (viewer.response) return viewer.response;
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);

  try {
    const raw: unknown = await req.json().catch(() => null);
    const body = requireRequestObject(raw, 'request body');
    requireKnownRequestKeys(body, [
      'member_id',
      'display_name',
      'tenant_slug',
      'role',
      'issue_token',
    ]);

    const memberId = typeof body.member_id === 'string' ? body.member_id.trim() : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const tenantSlug = typeof body.tenant_slug === 'string' ? body.tenant_slug.trim() : '';
    const role = body.role;
    const issueToken = body.issue_token === true;

    if (
      !isValidMemberId(memberId) ||
      !displayName ||
      !isValidTenantSlug(tenantSlug) ||
      !isHumanRole(role)
    ) {
      return NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_invalid_input', locale) },
        { status: 400 }
      );
    }

    // Owner authority is required on the tenant the member is being
    // created for — not merely the first tenant in the viewer's scope
    // (F2: a multi-tenant scope must not launder owner@A into writes on B).
    if (conciergeFrontDeskRoleForTenant(viewer.context, tenantSlug) !== 'owner') {
      return NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_owner_only', locale) },
        { status: 403 }
      );
    }

    const result = withExecutionContext('sovereign_concierge', () => {
      const existing = readMemberProfile(memberId);
      if (existing) throw new Error(`ALREADY_EXISTS:${memberId}`);

      const now = nowIso();
      let profile: MemberProfile = {
        member_id: memberId,
        display_name: displayName,
        status: 'active',
        memberships: [{ tenant_slug: tenantSlug, role }],
        access_registrations: [],
        created_at: now,
        updated_at: now,
      };

      let token: string | undefined;
      if (issueToken) {
        const serverRole: ChronosAccessRole = frontDeskRoleAuthority(role).serverRole;
        const issued = issueChronosAccessToken({
          role: serverRole,
          tenantSlugs: [tenantSlug],
          label: `${memberId}-token`,
          memberId,
        });
        token = issued.token;
        profile = {
          ...profile,
          access_registrations: [{ label: issued.registration.label! }],
        };
      }

      const written = writeMemberProfile(profile);
      return { member: toListItem(written), token };
    });

    return NextResponse.json({ ok: true, member: result.member, token: result.token ?? null });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('ALREADY_EXISTS:')) {
      return NextResponse.json(
        {
          ok: false,
          error: frontDeskText('settings_member_already_exists', locale, {
            memberId: error.message.split(':')[1],
          }),
        },
        { status: 409 }
      );
    }
    return conciergeErrorResponse(error, 500);
  }
}
