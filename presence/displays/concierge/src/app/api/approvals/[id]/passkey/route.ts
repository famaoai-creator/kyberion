import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContextAsync } from '@agent/core/authority';
import { decideApprovalRequest, loadApprovalRequest } from '@agent/core/governance/approval-store';
import {
  createApprovalPasskeyOptions,
  verifyApprovalPasskeyAssertion,
} from '@agent/core/authn/webauthn-verifier';
import { requireConciergeMutationAccess } from '../../../../../lib/api-guard';
import { readRequestObject } from '../../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../../lib/viewer-context';
import { conciergeDecisionDenied } from '../../../../../lib/front-desk-member';
import {
  approvalResourceTenant,
  conciergePasskeyMember,
  conciergeRelyingParty,
  passkeyErrorStatus,
  passkeyRateLimited,
  passkeyUnavailable,
} from '../../../../../lib/passkey-server';

export const dynamic = 'force-dynamic';

const ROLE = 'sovereign_concierge' as const;

/**
 * HA-07: approve or reject an approval card with a passkey (A3).
 * `action: 'options'` issues the challenge bound to what the card shows
 * (`presentedDigest`: the digest the card displayed — refused once stale);
 * `action: 'verify'` checks the assertion and only then records the decision
 * as `passkey`. The member is the viewer's own, resolved server-side.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const limited = passkeyRateLimited(req);
  if (limited) return limited;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;

  try {
    const { id } = await context.params;
    const parsedBody = await readRequestObject(req, 'request body', [
      'action',
      'decision',
      'channel',
      'storageChannel',
      'challengeId',
      'presentedDigest',
      'response',
      'reason',
    ]);
    if (!parsedBody.ok)
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    const { body } = parsedBody;
    const action = body.action;
    const decision =
      body.decision === 'approved' || body.decision === 'rejected' ? body.decision : null;
    if (!id || !decision || (action !== 'options' && action !== 'verify')) {
      return NextResponse.json(
        {
          ok: false,
          error: 'action (options|verify) and decision (approved|rejected) are required',
        },
        { status: 400 }
      );
    }
    const channel = typeof body.channel === 'string' && body.channel ? body.channel : 'chronos';
    const storageChannel =
      typeof body.storageChannel === 'string' && body.storageChannel
        ? body.storageChannel
        : channel;
    const record = loadApprovalRequest(storageChannel, id);
    if (!record) {
      return NextResponse.json(
        { ok: false, error: `approval request not found: ${id}` },
        { status: 404 }
      );
    }
    const resourceTenant = approvalResourceTenant(record);
    const decisionDenied = conciergeDecisionDenied(resolved.context, resourceTenant);
    if (decisionDenied) return decisionDenied;
    const member = conciergePasskeyMember(resolved.context, resourceTenant);
    if (!member) return passkeyUnavailable('member_required');
    const rp = conciergeRelyingParty(req);
    if (!rp) return passkeyUnavailable('origin_not_configured');

    if (action === 'options') {
      if (typeof body.presentedDigest !== 'string' || !body.presentedDigest) {
        return NextResponse.json(
          { ok: false, error: 'presentedDigest (the digest the card showed) is required' },
          { status: 400 }
        );
      }
      const presentedDigest = body.presentedDigest;
      const issued = await withExecutionContextAsync(ROLE, () =>
        createApprovalPasskeyOptions(ROLE, {
          record,
          storageChannel,
          decision,
          memberId: member.memberId,
          presentedDigest,
          rp,
        })
      );
      return NextResponse.json(
        { ok: true, challenge_id: issued.challengeId, options: issued.options },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (
      typeof body.challengeId !== 'string' ||
      typeof body.response !== 'object' ||
      !body.response
    ) {
      return NextResponse.json(
        { ok: false, error: 'challengeId and response are required' },
        { status: 400 }
      );
    }
    const challengeId = body.challengeId;
    const verified = await withExecutionContextAsync(ROLE, () =>
      verifyApprovalPasskeyAssertion(ROLE, {
        challengeId,
        storageChannel,
        requestId: id,
        decision,
        memberId: member.memberId,
        rp,
        response: body.response as Parameters<typeof verifyApprovalPasskeyAssertion>[1]['response'],
      })
    );
    const updated = decideApprovalRequest(ROLE, {
      channel,
      storageChannel,
      requestId: id,
      decision,
      decidedBy: member.decidedBy,
      decidedByDisplayName: member.displayName,
      decidedByRole: member.role ?? 'sovereign',
      authMethod: 'passkey',
      decidedByType: 'human',
      authenticated: true,
      deciderPrincipal: resolved.context.principal,
      presentedDigest: verified.presentedDigest,
      passkeyChallengeId: verified.challengeId,
      note:
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'Decision signed with a passkey from the concierge (秘書室) approval queue.',
    });
    return NextResponse.json({ ok: true, approval: updated });
  } catch (error) {
    return conciergeErrorResponse(error, passkeyErrorStatus(error));
  }
}
