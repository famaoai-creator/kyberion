/**
 * HA-07: server side of Concierge passkeys — registering a member's passkey
 * (settings) and approving an approval card with one.
 *
 * The member is always the one the viewer resolves to server-side
 * (`resolveConciergeDecidedBy`); a request body never names a member. The
 * relying party comes from the governed public origin (webauthn-verifier.ts).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  resolveWebAuthnRelyingParty,
  type WebAuthnRelyingParty,
} from '@agent/core/authn/webauthn-verifier';
import {
  surfaceDecisionAuthMethod,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import { refuseAgentHumanProof } from '@agent/core/governance/approval-human-decision';
import { auditChain } from '@agent/core/governance/audit-chain';
import { notifyOperator } from '@agent/core/surface/operator-notifications';
import { resolveConciergeDecidedBy } from './front-desk-member';
import { isLoopbackPeer } from './loopback-peer';
import {
  checkConciergeRateLimit,
  conciergeClientAddress,
  conciergeCredential,
  type ConciergeViewerContext,
} from './viewer-context';

/** Passkey ceremonies per credential per minute — well above a human's pace. */
const PASSKEY_RATE_LIMIT = 20;

export interface ConciergePasskeyMember {
  memberId: string;
  displayName: string;
}

/** The member behind the viewer, or null (a credential that resolves to no member). */
export function conciergePasskeyMember(
  viewer: ConciergeViewerContext,
  resourceTenant?: string
): (ConciergePasskeyMember & { decidedBy: string; role?: string }) | null {
  const decidedBy = resolveConciergeDecidedBy(viewer, resourceTenant);
  if (!decidedBy?.id.startsWith('user:')) return null;
  return {
    memberId: decidedBy.id.slice('user:'.length),
    displayName: decidedBy.display_name,
    decidedBy: decidedBy.id,
    role: decidedBy.role,
  };
}

export function conciergeRelyingParty(req: NextRequest): WebAuthnRelyingParty | null {
  let requestOrigin = '';
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    /* no usable request origin: only a declared public origin can work */
  }
  return resolveWebAuthnRelyingParty({
    surfaceId: 'concierge',
    requestOrigin,
    loopback: isLoopbackPeer(req),
  });
}

export function passkeyRateLimited(req: NextRequest): NextResponse | null {
  const token = conciergeCredential(req).token;
  const result = checkConciergeRateLimit(req, {
    limit: PASSKEY_RATE_LIMIT,
    key: `passkey:${token ? `token:${token}` : `ip:${conciergeClientAddress(req)}`}`,
  });
  if (result.ok) return null;
  return NextResponse.json(
    { ok: false, error: 'Concierge rate limit exceeded. Try again later.' },
    {
      status: 429,
      headers: result.retryAfterSeconds
        ? { 'Retry-After': String(result.retryAfterSeconds) }
        : undefined,
    }
  );
}

export function passkeyUnavailable(
  reason: 'member_required' | 'origin_not_configured'
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error:
        reason === 'member_required'
          ? 'Passkeys belong to a signed-in member; this credential resolves to no member.'
          : 'Passkeys need the public origin of this Concierge: set KYBERION_OIDC_PUBLIC_BASE_URL (or KYBERION_OIDC_PUBLIC_BASE_URLS concierge=…).',
      error_code: reason,
    },
    { status: reason === 'member_required' ? 403 : 503 }
  );
}

/**
 * Managing passkeys is itself an A3-grade change: only a member's own
 * signed-in browser (or OIDC) session may do it — never a registry bearer
 * token (a shared, copyable secret), a credential-less loopback viewer, or a
 * process acting for an agent. Null when allowed, else the 403 response.
 */
export function passkeyEnrollmentDenied(viewer: ConciergeViewerContext): NextResponse | null {
  const principal = viewer.principal;
  const refusal = (error: string, errorCode: string) =>
    NextResponse.json({ ok: false, error, error_code: errorCode }, { status: 403 });
  try {
    refuseAgentHumanProof(
      'passkey management refused',
      'manage passkeys from your own signed-in browser session',
      { principal }
    );
  } catch (error) {
    return refusal(error instanceof Error ? error.message : String(error), 'agent_refused');
  }
  if (
    !principal ||
    principal.provider === 'registry-token' ||
    surfaceDecisionAuthMethod(principal, true) !== 'surface_session'
  ) {
    return refusal(
      'Passkeys can be added or removed only from a signed-in browser session — not with an access token or an unauthenticated local viewer.',
      'session_required'
    );
  }
  return null;
}

/**
 * Audit and tell the operator about a passkey change (a new key can approve
 * A3 requests). The operator sees whether the change was confirmed with an
 * existing passkey, when a cooling-down key becomes usable, and when a
 * session alone removed a key that was still cooling down.
 */
export function reportPasskeyChange(
  member: { decidedBy: string; displayName: string },
  change: {
    operation: 'register' | 'revoke';
    credentialId: string;
    label?: string;
    /** The usable passkey whose step-up confirmed the change, if any. */
    steppedUpWith?: string;
    /** register: the enrollment cooldown end. */
    usableAfter?: string;
    /** revoke: the removed key was still cooling down. */
    wasCoolingDown?: boolean;
  }
): void {
  const steppedUp = Boolean(change.steppedUpWith);
  auditChain.record({
    agentId: member.decidedBy,
    action: 'passkey',
    operation: change.operation,
    result: 'allowed',
    reason:
      change.operation === 'register'
        ? 'member registered a passkey from Concierge settings'
        : 'member revoked one of their passkeys from Concierge settings',
    metadata: {
      credentialId: change.credentialId,
      steppedUp,
      ...(change.steppedUpWith ? { steppedUpWith: change.steppedUpWith } : {}),
      ...(change.usableAfter ? { usableAfter: change.usableAfter } : {}),
      ...(change.wasCoolingDown !== undefined ? { wasCoolingDown: change.wasCoolingDown } : {}),
    },
  });
  const how = steppedUp
    ? ' It was confirmed with an existing passkey.'
    : ' It was not confirmed with an existing passkey (signed-in session only).';
  const what =
    change.operation === 'register'
      ? `A passkey${change.label ? ` (${change.label})` : ''} was added for ${member.displayName}.${how}${
          change.usableAfter
            ? ` It is in its enrollment cooldown and can approve high-assurance requests from ${change.usableAfter}.`
            : ''
        }`
      : `A passkey was removed for ${member.displayName}.${how}${
          change.wasCoolingDown ? ' The removed passkey was still in its enrollment cooldown.' : ''
        }`;
  void notifyOperator('ops_alert', {
    title: change.operation === 'register' ? 'Passkey added' : 'Passkey removed',
    body: `${what} If this was not you, revoke it in Concierge settings and sign out other sessions.`,
    link_hint: '/settings',
    correlation_id: `passkey-${change.operation}-${change.credentialId}`,
  }).catch(() => undefined);
}

/** The tenant an approval decision lands on (the member gate checks that membership). */
export function approvalResourceTenant(record: ApprovalRequestRecord): string | undefined {
  const requesterContext = record.requestedByContext as
    { tenant_slug?: string; tenantSlug?: string } | undefined;
  const loopContext = record.work_loop?.context as { tenant_slug?: string } | undefined;
  return (
    record.scope?.tenant_slug ||
    requesterContext?.tenant_slug ||
    requesterContext?.tenantSlug ||
    loopContext?.tenant_slug
  );
}

/** A policy refusal from the verifier is the caller's to fix (400/403), not a server fault. */
export function passkeyErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('[POLICY_VIOLATION]') ? 403 : 500;
}
