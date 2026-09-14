import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso } from '@agent/core/foundation';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  isValidMemberId,
  readMemberProfile,
  writeMemberProfile,
  type MemberProfile,
} from '@agent/core/member-registry';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { requireKnownRequestKeys, requireRequestObject } from '../../../../lib/request-input';
import {
  conciergeErrorResponse,
  resolveConciergeViewer,
  type ConciergeViewerContext,
} from '../../../../lib/viewer-context';
import { resolveConciergeFrontDeskRole } from '../../../../lib/front-desk-member';
import { frontDeskText, resolveConciergeLocale } from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

const HUMAN_ROLES = ['owner', 'approver', 'viewer'] as const;
type HumanRole = (typeof HUMAN_ROLES)[number];

function isHumanRole(value: unknown): value is HumanRole {
  return typeof value === 'string' && (HUMAN_ROLES as readonly string[]).includes(value);
}

function requireOwnerViewer(
  req: NextRequest
):
  | { context: ConciergeViewerContext; response?: never }
  | { context?: never; response: NextResponse } {
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved;
  if (resolveConciergeFrontDeskRole(resolved.context) !== 'owner') {
    return {
      response: NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_owner_only', locale) },
        { status: 403 }
      ),
    };
  }
  return resolved;
}

/**
 * FD-07 「役割変更」「停止」: owner-only. No delete — `status` only ever
 * moves between `active` and `suspended` (plan §2.3: "削除なし（停止のみ）").
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const owner = requireOwnerViewer(req);
  if (owner.response) return owner.response;
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);

  try {
    const { id } = await context.params;
    if (!isValidMemberId(id)) {
      return NextResponse.json({ ok: false, error: 'invalid member id' }, { status: 400 });
    }

    const raw: unknown = await req.json().catch(() => null);
    const body = requireRequestObject(raw, 'request body');
    requireKnownRequestKeys(body, ['tenant_slug', 'role', 'status']);

    const tenantSlug = typeof body.tenant_slug === 'string' ? body.tenant_slug.trim() : undefined;
    const role = body.role;
    const status = body.status;

    if (tenantSlug !== undefined && !isValidTenantSlug(tenantSlug)) {
      return NextResponse.json({ ok: false, error: 'invalid tenant_slug' }, { status: 400 });
    }
    if (role !== undefined && !isHumanRole(role)) {
      return NextResponse.json({ ok: false, error: 'invalid role' }, { status: 400 });
    }
    if (status !== undefined && status !== 'active' && status !== 'suspended') {
      return NextResponse.json({ ok: false, error: 'invalid status' }, { status: 400 });
    }
    if ((tenantSlug !== undefined) !== (role !== undefined)) {
      return NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_patch_invalid', locale) },
        { status: 400 }
      );
    }
    if (tenantSlug === undefined && status === undefined) {
      return NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_patch_invalid', locale) },
        { status: 400 }
      );
    }

    const updated = withExecutionContext('sovereign_concierge', () => {
      const existing = readMemberProfile(id);
      if (!existing) return null;

      let memberships = existing.memberships;
      if (tenantSlug !== undefined && role !== undefined) {
        const index = memberships.findIndex((m) => m.tenant_slug === tenantSlug);
        memberships =
          index >= 0
            ? memberships.map((m, i) => (i === index ? { tenant_slug: tenantSlug, role } : m))
            : [...memberships, { tenant_slug: tenantSlug, role }];
      }

      const next: MemberProfile = {
        ...existing,
        memberships,
        ...(status !== undefined ? { status } : {}),
        updated_at: nowIso(),
      };
      return writeMemberProfile(next);
    });

    if (!updated) {
      return NextResponse.json(
        { ok: false, error: frontDeskText('settings_member_not_found', locale) },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, member: updated });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
