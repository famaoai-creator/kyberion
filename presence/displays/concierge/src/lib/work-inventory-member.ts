import { NextResponse, type NextRequest } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal, type MemberProfile } from '@agent/core/member-registry';
import type { WorkInventoryScope } from '@agent/core/work-inventory';
import { WorkInventoryConsentError } from '@agent/core/work-inventory-consent';
import { conciergeErrorResponse, type ConciergeViewerContext } from './viewer-context';
import { frontDeskText, resolveConciergeLocale } from './i18n';

/**
 * WI-15 (docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md §9):
 * resolve the signed-in member behind a Concierge viewer for the "PC 操作の
 * 記録" consent / observation routes. Mirrors `resolveConciergeDecidedBy` in
 * shape, but returns the raw `MemberProfile` — the work-inventory consent /
 * observation modules key their records on the bare `member_id`, never the
 * `user:<id>` actor-id wrapper `resolveConciergeDecidedBy` returns. Never
 * accepts a client-supplied member id: `principalId` / `source` /
 * `registrationLabel` all come from the server-resolved viewer.
 */
export function resolveWorkInventoryMember(viewer: ConciergeViewerContext): MemberProfile | null {
  return withExecutionContext('sovereign_concierge', () =>
    resolveMemberByPrincipal({
      principalId: viewer.principalId,
      source: viewer.source,
      registrationLabel: viewer.registrationLabel,
    })
  );
}

/** 404s (never 401 — the viewer already authenticated) when no member record backs this viewer. */
export function requireWorkInventoryMember(
  req: NextRequest,
  viewer: ConciergeViewerContext
): { member: MemberProfile; response?: never } | { member?: never; response: NextResponse } {
  const member = resolveWorkInventoryMember(viewer);
  if (member) return { member };
  const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
  return {
    response: NextResponse.json(
      { ok: false, error: frontDeskText('settings_recording_member_not_found', locale) },
      { status: 404 }
    ),
  };
}

/**
 * Plan §2.3 ③ scope rule, mirrored from presence-studio's
 * `resolveWorkInventoryScopeForViewer` (`work-inventory-routes.ts`): the
 * viewer's first tenant slug resolves to that tenant's scope; a loopback
 * viewer with no concrete tenant (no tenant configured, or the localadmin
 * `'all'` fallback) resolves to the personal scope; a remote viewer with no
 * concrete tenant resolves to no scope at all — never someone else's
 * personal work inventory.
 */
export function resolveWorkInventoryScopeForViewer(
  viewer: ConciergeViewerContext
): WorkInventoryScope | null {
  const namespace = viewer.tenantSlugs === 'all' ? 'all' : viewer.tenantSlugs[0] || 'unscoped';
  if (namespace === 'all' || namespace === 'unscoped') {
    return viewer.source === 'loopback' ? {} : null;
  }
  return { tenant_slug: namespace };
}

const CONSENT_ERROR_STATUS: Record<string, 400 | 403 | 404 | 409> = {
  invalid_input: 400,
  forbidden_observation_kind: 400,
  no_consent: 400,
  consent_expired: 400,
  consent_revoked: 400,
  source_not_covered: 400,
  recording_not_reviewed: 400,
  invalid_recording: 400,
  not_subject: 403,
  not_found: 404,
  invalid_state: 409,
  tenant_mismatch: 409,
};

/**
 * Maps `WorkInventoryConsentError` (consent grant/revoke, observation
 * confirm/discard/attach) to a client-safe response: every domain error
 * message here is already built from identifiers only (consent/summary/entry
 * ids, member ids) — never a file path or stack trace — so it is safe to
 * forward verbatim. Anything else falls back to the generic 500 mapper,
 * which never leaks internals.
 */
export function workInventoryErrorResponse(error: unknown): NextResponse {
  if (error instanceof WorkInventoryConsentError) {
    return NextResponse.json(
      { ok: false, error: error.message, error_code: error.code },
      { status: CONSENT_ERROR_STATUS[error.code] ?? 400 }
    );
  }
  return conciergeErrorResponse(error, 500);
}
