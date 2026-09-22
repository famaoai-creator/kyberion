import { NextResponse, type NextRequest } from 'next/server';
import { withExecutionContext } from '@agent/core/authority';
import { resolveMemberByPrincipal, type MemberProfile } from '@agent/core/member-registry';
import type { WorkInventoryScope } from '@agent/core/work-inventory';
import { WorkInventoryConsentError } from '@agent/core/work-inventory-consent';
import { authorizeSurfaceMutation } from '@agent/core/surface-mutation-guard';
import {
  conciergeErrorResponse,
  guardConciergeRequest,
  type ConciergeViewerContext,
} from './viewer-context';
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
 * WI-18 (user decision 2026-09-22,
 * docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
 * §10): narrow self-service write gate for exactly two write shapes — a
 * member's own recording consent (grant/revoke) and confirming/discarding
 * their own observation summary. Every other Concierge self-service
 * mutation — including `attach`, which updates a shared tenant/personal
 * work-inventory entry — still requires `requireConciergeMutationAccess`
 * (localadmin/loopback only). Do not reach for this function for anything
 * else; it exists only to widen those two write shapes to read-only
 * (`viewer` / server role `readonly`) members writing their own data.
 *
 * Applies the same CSRF/rate-limit posture as `requireConciergeMutationAccess`
 * (`guardConciergeRequest` + `authorizeSurfaceMutation`), but skips its
 * "bearer token must resolve to a localadmin viewer" check — any resolvable
 * viewer, including a `readonly`-role token viewer, passes here as long as the
 * request is same-origin (a client without an Origin header still gets the
 * CSRF 403 from `authorizeSurfaceMutation`). The actual
 * authorization is the member-resolution gate every caller already runs
 * right after (`requireWorkInventoryMember`, backed by
 * `resolveMemberByPrincipal`'s `status === 'active'` filter): an anonymous
 * viewer still 401s there (via `resolveConciergeViewer`), and an unresolved
 * or suspended member still 404s there. This function never accepts a
 * client-supplied member id and has no role check of its own — it must
 * never be used to widen access on any other route.
 */
export function requireConciergeSelfServiceAccess(req: NextRequest): NextResponse | null {
  const rateLimitResponse = guardConciergeRequest(req);
  if (rateLimitResponse) return rateLimitResponse;
  const decision = authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }
  return null;
}

/**
 * Plan §2.3 ③ scope rule, mirrored from presence-studio's
 * `resolveWorkInventoryScopeForViewer` (`work-inventory-routes.ts`): the
 * viewer's first tenant slug resolves to that tenant's scope; a loopback
 * viewer with no concrete tenant (no tenant configured, or the localadmin
 * `'all'` fallback) resolves to the personal scope; a remote viewer with no
 * concrete tenant resolves to no scope at all — never someone else's
 * personal work inventory.
 *
 * Conscious decision (WI-15 review): the loopback viewer is the local owner,
 * so listing their own personal inventory titles is intentional — the same
 * rule presence-studio applies — even though the Concierge viewer's default
 * tier mask excludes `personal`. The personal scope here is the owner's own
 * inventory, not a tier-mask widening for anyone else.
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
