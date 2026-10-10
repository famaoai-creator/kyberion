import { NextRequest, NextResponse } from 'next/server';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import {
  createPasskeyRegistrationOptions,
  createPasskeyStepUpOptions,
  revokeMemberPasskey,
  verifyPasskeyRegistration,
  verifyPasskeyStepUp,
} from '@agent/core/authn/webauthn-verifier';
import { listPasskeyCredentials } from '@agent/core/authn/passkey-credential-store';
import { passkeyStepUpRequired } from '@agent/core/authn/passkey-step-up';
import { requireConciergeMutationAccess } from '../../../../lib/api-guard';
import { readRequestObject } from '../../../../lib/request-input';
import { conciergeErrorResponse, resolveConciergeViewer } from '../../../../lib/viewer-context';
import {
  conciergePasskeyMember,
  conciergeRelyingParty,
  passkeyEnrollmentDenied,
  passkeyErrorStatus,
  passkeyRateLimited,
  passkeyUnavailable,
  reportPasskeyChange,
} from '../../../../lib/passkey-server';

export const dynamic = 'force-dynamic';

const ROLE = 'sovereign_concierge';
const ACTIONS = ['options', 'verify', 'revoke', 'step_up_options', 'step_up_verify'] as const;

/**
 * The viewer's own passkeys (never key material), and whether adding or
 * removing one first needs a confirmation with a usable passkey.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const member = conciergePasskeyMember(resolved.context);
    if (!member) {
      return NextResponse.json(
        { ok: true, member: false, passkeys: [], step_up_required: false },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const { passkeys, stepUpRequired } = withExecutionContext(ROLE, () => ({
      passkeys: listPasskeyCredentials(member.memberId),
      stepUpRequired: passkeyStepUpRequired(member.memberId, new Date()),
    }));
    return NextResponse.json(
      { ok: true, member: true, passkeys, step_up_required: stepUpRequired },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return conciergeErrorResponse(error, 500);
  }
}

/**
 * `options` starts a registration, `verify` completes it (`response`, optional
 * `label`), `revoke` removes one of the viewer's passkeys (`credential_id`).
 * While the member has a usable passkey, a registration or revoke first needs
 * `step_up_options` (`purpose` enroll|revoke, `credential_id` for revoke) and
 * `step_up_verify` (`response`) — an assertion from that usable passkey —
 * which returns a single-use `step_up_token`. Only the browser that ran the
 * step-up holds it; `options`, `verify` and `revoke` must send it back.
 */
export async function POST(req: NextRequest) {
  const denied = requireConciergeMutationAccess(req);
  if (denied) return denied;
  const limited = passkeyRateLimited(req);
  if (limited) return limited;
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const parsedBody = await readRequestObject(req, 'request body', [
      'action',
      'response',
      'label',
      'credential_id',
      'purpose',
      'step_up_token',
    ]);
    if (!parsedBody.ok) {
      return NextResponse.json({ ok: false, error: parsedBody.error }, { status: 400 });
    }
    const { body } = parsedBody;
    const action = ACTIONS.find((candidate) => candidate === body.action);
    if (!action) {
      return NextResponse.json(
        { ok: false, error: `action must be one of ${ACTIONS.join(', ')}` },
        { status: 400 }
      );
    }
    const refused = passkeyEnrollmentDenied(resolved.context);
    if (refused) return refused;
    const member = conciergePasskeyMember(resolved.context);
    if (!member) return passkeyUnavailable('member_required');
    const credentialId =
      typeof body.credential_id === 'string' && body.credential_id ? body.credential_id : undefined;
    const stepUpToken =
      typeof body.step_up_token === 'string' && body.step_up_token ? body.step_up_token : undefined;

    if (action === 'revoke') {
      if (!credentialId) {
        return NextResponse.json(
          { ok: false, error: 'credential_id is required' },
          { status: 400 }
        );
      }
      const revoked = withExecutionContext(ROLE, () =>
        revokeMemberPasskey({ memberId: member.memberId, credentialId, stepUpToken })
      );
      if (!revoked) {
        return NextResponse.json({ ok: false, error: 'passkey not found' }, { status: 404 });
      }
      reportPasskeyChange(member, {
        operation: 'revoke',
        credentialId,
        steppedUpWith: revoked.steppedUpWith,
        wasCoolingDown: revoked.wasCoolingDown,
      });
      return NextResponse.json({ ok: true });
    }

    const rp = conciergeRelyingParty(req);
    if (!rp) return passkeyUnavailable('origin_not_configured');

    if (action === 'step_up_options') {
      if (body.purpose !== 'enroll' && body.purpose !== 'revoke') {
        return NextResponse.json(
          { ok: false, error: 'purpose must be enroll or revoke' },
          { status: 400 }
        );
      }
      if (body.purpose === 'revoke' && !credentialId) {
        return NextResponse.json(
          { ok: false, error: 'credential_id is required to confirm a revoke' },
          { status: 400 }
        );
      }
      const purpose = body.purpose;
      const options = await withExecutionContextAsync(ROLE, () =>
        createPasskeyStepUpOptions({
          memberId: member.memberId,
          purpose,
          ...(purpose === 'revoke' ? { target: credentialId } : {}),
          rp,
        })
      );
      return NextResponse.json({ ok: true, options }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === 'options') {
      const options = await withExecutionContextAsync(ROLE, () =>
        createPasskeyRegistrationOptions({
          memberId: member.memberId,
          displayName: member.displayName,
          rp,
          stepUpToken,
        })
      );
      return NextResponse.json({ ok: true, options }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (typeof body.response !== 'object' || !body.response) {
      return NextResponse.json({ ok: false, error: 'response is required' }, { status: 400 });
    }

    if (action === 'step_up_verify') {
      const response = body.response as Parameters<typeof verifyPasskeyStepUp>[0]['response'];
      const confirmed = await withExecutionContextAsync(ROLE, () =>
        verifyPasskeyStepUp({ memberId: member.memberId, response, rp })
      );
      return NextResponse.json(
        {
          ok: true,
          purpose: confirmed.purpose,
          ...(confirmed.target ? { credential_id: confirmed.target } : {}),
          step_up_token: confirmed.stepUpToken,
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const response = body.response as Parameters<typeof verifyPasskeyRegistration>[0]['response'];
    const passkey = await withExecutionContextAsync(ROLE, () =>
      verifyPasskeyRegistration({
        memberId: member.memberId,
        response,
        rp,
        label: typeof body.label === 'string' ? body.label : undefined,
        stepUpToken,
      })
    );
    reportPasskeyChange(member, {
      operation: 'register',
      credentialId: passkey.credential_id,
      label: passkey.label,
      steppedUpWith: passkey.enrolled_with,
      usableAfter: passkey.usable_after,
    });
    return NextResponse.json({ ok: true, passkey });
  } catch (error) {
    return conciergeErrorResponse(error, passkeyErrorStatus(error));
  }
}
