import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { listTenantProfileSlugs } from '@agent/core/tenant-registry';
import { listMemberIds, readMemberProfile, type MemberProfile } from '@agent/core/member-registry';
import {
  loadTrainingCatalog,
  readTrainingAssignments,
  readTrainingProgress,
  summarizeTrainingProgress,
} from '@agent/core/training-catalog';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import { conciergeFrontDeskRoleForTenant } from '../../../../lib/front-desk-member';
import { frontDeskText, resolveConciergeLocale } from '../../../../lib/i18n';

export const dynamic = 'force-dynamic';

/**
 * HT-05 second pass: per-member training progress overview for the 組織と
 * メンバー settings pane — owner-only (same gate as the training assignment
 * POST route) and tenant-narrowed via the resolved viewer's own
 * `tenantSlugs`, never a client-supplied member id or tenant. In-process
 * like `training/assignments/route.ts`, reusing the same pure
 * `summarizeTrainingProgress` helper `training-routes.ts` uses on the
 * presence-studio surface.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  // The overview spans every tenant the caller is an owner of — a resolved
  // member sees progress only for tenants where their membership is
  // `owner`, never the whole scope (F2: tenantSlugs[0] is not authority).
  // For an unregistered principal `conciergeFrontDeskRoleForTenant` keeps
  // the legacy localadmin -> owner mapping, preserving pre-FD-07 behavior.
  const tenants = (
    resolved.context.tenantSlugs === 'all'
      ? withExecutionContext('sovereign_concierge', () => listTenantProfileSlugs())
      : resolved.context.tenantSlugs
  ).filter((tenant) => conciergeFrontDeskRoleForTenant(resolved.context, tenant) === 'owner');
  if (tenants.length === 0) {
    return NextResponse.json(
      { ok: false, error: frontDeskText('settings_member_owner_only', locale) },
      { status: 403 }
    );
  }
  try {
    const overview = withExecutionContext('sovereign_concierge', () => {
      const catalog = loadTrainingCatalog();
      const members = listMemberIds()
        .map((memberId) => readMemberProfile(memberId))
        .filter((profile): profile is MemberProfile => Boolean(profile))
        .filter((profile) =>
          profile.memberships.some((membership) => tenants.includes(membership.tenant_slug))
        );
      const assignments = tenants.flatMap((tenant) => readTrainingAssignments(tenant).assignments);
      const progressByMember = Object.fromEntries(
        members.map((profile) => [profile.member_id, readTrainingProgress(profile.member_id)])
      );
      const summaries = summarizeTrainingProgress(catalog, assignments, progressByMember);
      const displayNameById = new Map(
        members.map((profile) => [profile.member_id, profile.display_name])
      );
      return summaries.map((summary) => ({
        ...summary,
        display_name: displayNameById.get(summary.member_id) ?? summary.member_id,
      }));
    });
    return NextResponse.json({ ok: true, overview }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}
