/**
 * HA-07: step-up proof for changing a member's passkeys. Once a member has a
 * usable passkey, enrolling another or revoking one needs a fresh assertion
 * from a usable passkey — a signed-in session alone (A2) never changes the
 * member's A3 credentials.
 *
 * The WebAuthn challenge is `base64url(sha256(binding))` over the purpose
 * (`enroll` | `revoke`), the member, the revoke target, the expiry and a
 * nonce. It lives in the member's passkey file and moves through
 * `issued → claimed → verified → consumed` at most once each, within a short
 * TTL; issuing a new one replaces any earlier one.
 *
 * Verifying it hands the browser that ran the ceremony a random 256-bit
 * step-up token; only its sha256 is stored. The change it authorizes must
 * present that token, so another session of the same member cannot spend a
 * step-up it did not perform.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  isPasskeyUsable,
  readPasskeyCredentialFile,
  updatePasskeyCredentialFile,
  type PasskeyCredential,
  type PasskeyCredentialFile,
  type PasskeyPendingStepUp,
  type PasskeyStepUpPurpose,
  type PasskeyStorePathOptions,
} from './passkey-credential-store.js';

export const PASSKEY_STEP_UP_TTL_MS = 120_000;

export function passkeyStepUpBinding(
  memberId: string,
  stepUp: Pick<PasskeyPendingStepUp, 'purpose' | 'target' | 'expires_at' | 'nonce'>
): string {
  return [
    'kyberion-passkey-step-up-v1',
    stepUp.purpose,
    memberId,
    stepUp.target ?? '',
    stepUp.expires_at,
    stepUp.nonce,
  ].join('\n');
}

/** sha256 (base64url) of a step-up token — what the passkey file keeps. */
export function hashPasskeyStepUpToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Constant-time comparison of a presented token against a stored hash. */
export function passkeyStepUpTokenMatches(
  token: string | undefined,
  storedHash: string | undefined
): boolean {
  if (!token || !storedHash) return false;
  const presented = Buffer.from(hashPasskeyStepUpToken(token));
  const stored = Buffer.from(storedHash);
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

function encodeChallenge(memberId: string, stepUp: Parameters<typeof passkeyStepUpBinding>[1]) {
  return createHash('sha256').update(passkeyStepUpBinding(memberId, stepUp)).digest('base64url');
}

function refuse(reason: string, evidence: string): never {
  throw new Error(
    `[POLICY_VIOLATION] passkey step-up refused — ${reason} ` +
      '| next: confirm with one of your usable passkeys again, then retry the change ' +
      `| evidence: ${evidence}`
  );
}

export function usablePasskeys(
  memberId: string,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): PasskeyCredential[] {
  return (readPasskeyCredentialFile(memberId, options)?.credentials ?? []).filter((entry) =>
    isPasskeyUsable(entry, now)
  );
}

/** Whether changing the member's passkeys needs a step-up (they have a usable one). */
export function passkeyStepUpRequired(
  memberId: string,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): boolean {
  return usablePasskeys(memberId, now, options).length > 0;
}

/** Issue the step-up challenge; returns it with the passkeys that may answer it. */
export function issuePasskeyStepUp(
  memberId: string,
  params: { purpose: PasskeyStepUpPurpose; target?: string; now?: Date },
  options: PasskeyStorePathOptions = {}
): { stepUp: PasskeyPendingStepUp; allow: PasskeyCredential[] } {
  const now = params.now ?? new Date();
  if (params.purpose === 'revoke' && !params.target) refuse('revoke needs its target', memberId);
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const allow = current.credentials.filter((entry) => isPasskeyUsable(entry, now));
    if (!allow.length) refuse('no usable passkey to confirm with', memberId);
    if (
      params.target &&
      !current.credentials.some((entry) => entry.credential_id === params.target)
    ) {
      refuse('the passkey to revoke is not registered to this member', params.target);
    }
    const base = {
      purpose: params.purpose,
      ...(params.target ? { target: params.target } : {}),
      nonce: randomBytes(16).toString('base64url'),
      expires_at: new Date(now.getTime() + PASSKEY_STEP_UP_TTL_MS).toISOString(),
    };
    const stepUp: PasskeyPendingStepUp = { ...base, challenge: encodeChallenge(memberId, base) };
    return { next: { ...current, pending_step_up: stepUp }, result: { stepUp, allow } };
  });
}

function assertIntact(memberId: string, stepUp: PasskeyPendingStepUp | undefined, now: Date) {
  if (!stepUp) refuse('no step-up is in progress', memberId);
  if (stepUp.challenge !== encodeChallenge(memberId, stepUp)) {
    refuse('step-up does not match its binding', memberId);
  }
  if (Date.parse(stepUp.expires_at) <= now.getTime()) {
    refuse('step-up expired', `expires_at ${stepUp.expires_at}`);
  }
  return stepUp;
}

/** Claim the step-up for one verification attempt; a second attempt is refused. */
export function claimPasskeyStepUp(
  memberId: string,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): PasskeyPendingStepUp {
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const stepUp = assertIntact(memberId, current.pending_step_up, now);
    if (stepUp.claimed_at) refuse('step-up was already used', `claimed_at ${stepUp.claimed_at}`);
    const claimed = { ...stepUp, claimed_at: now.toISOString() };
    return { next: { ...current, pending_step_up: claimed }, result: claimed };
  });
}

/** Record the verified assertion; returns the step-up token (shown once, never stored). */
export function markPasskeyStepUpVerified(
  memberId: string,
  claimed: PasskeyPendingStepUp,
  credentialId: string,
  now: Date = new Date(),
  options: PasskeyStorePathOptions = {}
): string {
  const token = randomBytes(32).toString('base64url');
  updatePasskeyCredentialFile(memberId, options, (current) => {
    const stepUp = current.pending_step_up;
    if (!stepUp || stepUp.nonce !== claimed.nonce || stepUp.claimed_at !== claimed.claimed_at) {
      refuse('step-up changed during verification', memberId);
    }
    if (stepUp.verified_at) refuse('step-up was already used', `verified_at ${stepUp.verified_at}`);
    return {
      next: {
        ...current,
        pending_step_up: {
          ...stepUp,
          verified_at: now.toISOString(),
          credential_id: credentialId,
          token_hash: hashPasskeyStepUpToken(token),
        },
      },
      result: undefined,
    };
  });
  return token;
}

export interface PasskeyStepUpSpend {
  purpose: PasskeyStepUpPurpose;
  target?: string;
  /** The token `step_up_verify` returned to the browser that confirmed. */
  token?: string;
  now?: Date;
}

/**
 * Inside the member's lock: check the verified step-up for exactly `purpose`
 * (and `target`) and the presented token, and return the file without it
 * plus the passkey that confirmed it (which must still be usable).
 */
export function spendPasskeyStepUp(
  memberId: string,
  current: PasskeyCredentialFile,
  params: PasskeyStepUpSpend
): { rest: PasskeyCredentialFile; credentialId: string } {
  const now = params.now ?? new Date();
  if (!current.pending_step_up) {
    refuse(
      `changing passkeys needs a confirmation with a usable passkey (${params.purpose})`,
      memberId
    );
  }
  const stepUp = assertIntact(memberId, current.pending_step_up, now);
  if (!stepUp.verified_at || !stepUp.credential_id) refuse('step-up was not verified', memberId);
  if (!passkeyStepUpTokenMatches(params.token, stepUp.token_hash)) {
    refuse('the step-up token is missing or belongs to another confirmation', memberId);
  }
  if (stepUp.purpose !== params.purpose || (stepUp.target ?? '') !== (params.target ?? '')) {
    refuse(
      'step-up was confirmed for another change',
      `${stepUp.purpose}${stepUp.target ? ` ${stepUp.target}` : ''}`
    );
  }
  const confirming = current.credentials.find(
    (entry) => entry.credential_id === stepUp.credential_id
  );
  if (!confirming || !isPasskeyUsable(confirming, now)) {
    refuse('the confirming passkey is no longer usable', stepUp.credential_id);
  }
  const { pending_step_up: _consumed, ...rest } = current;
  return { rest, credentialId: stepUp.credential_id };
}

/** Consume the verified step-up (see {@link spendPasskeyStepUp}); returns the confirming passkey. */
export function consumePasskeyStepUp(
  memberId: string,
  params: PasskeyStepUpSpend,
  options: PasskeyStorePathOptions = {}
): string {
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const { rest, credentialId } = spendPasskeyStepUp(memberId, current, params);
    return { next: rest, result: credentialId };
  });
}
