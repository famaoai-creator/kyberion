/**
 * HA-07: WebAuthn (passkey) registration and approval assertions, wrapping
 * `@simplewebauthn/server`.
 *
 * - The relying party (rpID + origin) comes from governed configuration —
 *   the surface's declared public origin (`KYBERION_OIDC_PUBLIC_BASE_URLS` /
 *   `KYBERION_OIDC_PUBLIC_BASE_URL`). The request origin is used only for a
 *   proven loopback peer (`loopback`, resolved by the server from the socket):
 *   a Host header — even `localhost` — never picks it.
 * - An approval assertion signs the challenge of
 *   governance/approval-passkey-challenge.ts (presented digest + request id
 *   + decision + expiry + nonce). Verification requires user verification,
 *   the expected rpID / origin / challenge, a credential registered to the
 *   deciding member that is past its enrollment cooldown (`usable_after`),
 *   and a signature counter that moves forward.
 * - Enrollment: once a member has a usable passkey, enrolling or revoking
 *   one needs a step-up assertion from a usable passkey (passkey-step-up.ts).
 *   A passkey enrolled without one (the first, or while the only others are
 *   still cooling down) is usable only after the policy cooldown
 *   (`passkey_enrollment_cooldown_hours`). The step-up token the confirming
 *   browser received must accompany the registration (options and verify)
 *   or the revoke, so another session of the member cannot spend it.
 *
 * Credential and challenge persistence run in the caller's execution context
 * (personal tier for credentials; `role` for challenges).
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { getRegisteredEnvText } from '../foundation/env.js';
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  APPROVAL_PASSKEY_CHALLENGE_TTL_MS,
  claimApprovalPasskeyChallenge,
  issueApprovalPasskeyChallenge,
  markApprovalPasskeyChallengeVerified,
  type ApprovalPasskeyDecision,
} from '../governance/approval-passkey-challenge.js';
import {
  addPasskeyCredential,
  beginPasskeyRegistration,
  findPasskeyCredential,
  isPasskeyUsable,
  PASSKEY_LABEL_MAX,
  readPasskeyCredentialFile,
  recordPasskeyUse,
  takePendingPasskeyRegistration,
  updatePasskeyCredentialFile,
  type PasskeyCredential,
  type PasskeyCredentialSummary,
  type PasskeyStepUpPurpose,
  type PasskeyStorePathOptions,
} from './passkey-credential-store.js';
import {
  claimPasskeyStepUp,
  consumePasskeyStepUp,
  hashPasskeyStepUpToken,
  issuePasskeyStepUp,
  markPasskeyStepUpVerified,
  passkeyStepUpRequired,
  passkeyStepUpTokenMatches,
  spendPasskeyStepUp,
  PASSKEY_STEP_UP_TTL_MS,
} from './passkey-step-up.js';
import {
  MIN_PASSKEY_ENROLLMENT_COOLDOWN_HOURS,
  resolvePasskeyEnrollmentCooldownHours,
} from '../governance/approval-policy.js';

export const PASSKEY_REGISTRATION_TTL_MS = 300_000;
const RP_NAME = 'Kyberion';

export interface WebAuthnRelyingParty {
  rpId: string;
  origin: string;
  rpName: string;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost'
  );
}

function declaredOrigin(
  surfaceId: string,
  env: Record<string, string | undefined> | undefined
): string | undefined {
  const perSurface = getRegisteredEnvText('KYBERION_OIDC_PUBLIC_BASE_URLS', { env }) ?? '';
  for (const entry of perSurface.split(',')) {
    const index = entry.indexOf('=');
    if (index > 0 && entry.slice(0, index).trim() === surfaceId) {
      const url = entry.slice(index + 1).trim();
      if (url) return url;
    }
  }
  return getRegisteredEnvText('KYBERION_OIDC_PUBLIC_BASE_URL', { env })?.trim() || undefined;
}

/**
 * The relying party for `surfaceId`, or null when none can be established
 * safely (a remote request with no declared public origin, or a non-HTTPS
 * non-loopback origin).
 */
export function resolveWebAuthnRelyingParty(input: {
  surfaceId: string;
  requestOrigin: string;
  loopback: boolean;
  env?: Record<string, string | undefined>;
}): WebAuthnRelyingParty | null {
  const raw =
    declaredOrigin(input.surfaceId, input.env) ??
    (input.loopback ? input.requestOrigin : undefined);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return null;
    }
    return { rpId: url.hostname, origin: url.origin, rpName: RP_NAME };
  } catch {
    return null;
  }
}

function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(base64url, 'base64url'));
}

function refuse(reason: string, evidence: string): never {
  throw new Error(
    `[POLICY_VIOLATION] passkey verification failed — ${reason} ` +
      '| next: try again with a passkey registered to your own account ' +
      `| evidence: ${evidence}`
  );
}

function transportsOf(values: string[] | undefined): AuthenticatorTransportFuture[] | undefined {
  return values?.length ? (values as AuthenticatorTransportFuture[]) : undefined;
}

export async function createPasskeyRegistrationOptions(params: {
  memberId: string;
  displayName: string;
  rp: WebAuthnRelyingParty;
  /** The token from `verifyPasskeyStepUp` (required while a usable passkey exists). */
  stepUpToken?: string;
  now?: Date;
  store?: PasskeyStorePathOptions;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const now = params.now ?? new Date();
  const steppedUpWith = passkeyStepUpRequired(params.memberId, now, params.store)
    ? consumePasskeyStepUp(
        params.memberId,
        { purpose: 'enroll', token: params.stepUpToken, now },
        params.store
      )
    : undefined;
  const existing = readPasskeyCredentialFile(params.memberId, params.store);
  const options = await generateRegistrationOptions({
    rpName: params.rp.rpName,
    rpID: params.rp.rpId,
    userName: params.memberId,
    userDisplayName: params.displayName,
    ...(existing ? { userID: toBytes(existing.user_handle) } : {}),
    timeout: PASSKEY_REGISTRATION_TTL_MS,
    attestationType: 'none',
    excludeCredentials: (existing?.credentials ?? []).map((entry) => ({
      id: entry.credential_id,
      transports: transportsOf(entry.transports),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const { userHandle } = beginPasskeyRegistration(
    params.memberId,
    {
      challenge: options.challenge,
      expires_at: new Date(now.getTime() + PASSKEY_REGISTRATION_TTL_MS).toISOString(),
      ...(steppedUpWith && params.stepUpToken
        ? {
            stepped_up_with: steppedUpWith,
            step_up_token_hash: hashPasskeyStepUpToken(params.stepUpToken),
          }
        : {}),
    },
    params.store
  );
  // A first registration creates the handle while storing the challenge.
  return { ...options, user: { ...options.user, id: userHandle } };
}

export async function verifyPasskeyRegistration(params: {
  memberId: string;
  response: RegistrationResponseJSON;
  rp: WebAuthnRelyingParty;
  label?: string;
  /** The same step-up token the registration was started with, if it was stepped up. */
  stepUpToken?: string;
  now?: Date;
  /** Enrollment cooldown (≥ 1h); defaults to approval-policy.json `passkey_enrollment_cooldown_hours`. */
  cooldownHours?: number;
  store?: PasskeyStorePathOptions;
}): Promise<PasskeyCredentialSummary> {
  const now = params.now ?? new Date();
  const pending = takePendingPasskeyRegistration(params.memberId, now, params.store);
  const expectedChallenge = pending.challenge;
  if (
    pending.stepped_up_with &&
    !passkeyStepUpTokenMatches(params.stepUpToken, pending.step_up_token_hash)
  ) {
    refuse(
      'this registration was confirmed from another session',
      'step-up token missing or mismatched'
    );
  }
  const confirming = pending.stepped_up_with
    ? findPasskeyCredential(params.memberId, pending.stepped_up_with, params.store)
    : null;
  const steppedUp = Boolean(confirming && isPasskeyUsable(confirming, now));
  if (!steppedUp && passkeyStepUpRequired(params.memberId, now, params.store)) {
    refuse(
      'enrolling another passkey needs a confirmation with a usable passkey',
      'no step-up for this registration'
    );
  }
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: params.rp.origin,
      expectedRPID: params.rp.rpId,
      requireUserVerification: true,
    });
  } catch (error) {
    refuse(
      'registration response did not verify',
      error instanceof Error ? error.message : String(error)
    );
  }
  if (!verification.verified) refuse('registration response did not verify', 'verified=false');
  const { credential } = verification.registrationInfo;
  const label = (params.label ?? '').trim().slice(0, PASSKEY_LABEL_MAX) || 'Passkey';
  const cooldownMs = steppedUp
    ? 0
    : Math.max(
        MIN_PASSKEY_ENROLLMENT_COOLDOWN_HOURS,
        params.cooldownHours ?? resolvePasskeyEnrollmentCooldownHours()
      ) * 3_600_000;
  return addPasskeyCredential(
    params.memberId,
    {
      credential_id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      ...(credential.transports?.length ? { transports: [...credential.transports] } : {}),
      label,
      created_at: now.toISOString(),
      ...(cooldownMs > 0
        ? { usable_after: new Date(now.getTime() + cooldownMs).toISOString() }
        : {}),
      ...(steppedUp && pending.stepped_up_with ? { enrolled_with: pending.stepped_up_with } : {}),
    },
    params.store
  );
}

/** Start a step-up: a fresh assertion from a usable passkey authorizes one enroll / revoke. */
export async function createPasskeyStepUpOptions(params: {
  memberId: string;
  purpose: PasskeyStepUpPurpose;
  target?: string;
  rp: WebAuthnRelyingParty;
  now?: Date;
  store?: PasskeyStorePathOptions;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { stepUp, allow } = issuePasskeyStepUp(params.memberId, params, params.store);
  return generateAuthenticationOptions({
    rpID: params.rp.rpId,
    challenge: toBytes(stepUp.challenge),
    timeout: PASSKEY_STEP_UP_TTL_MS,
    userVerification: 'required',
    allowCredentials: allow.map((entry) => ({
      id: entry.credential_id,
      transports: transportsOf(entry.transports),
    })),
  });
}

export async function verifyPasskeyStepUp(params: {
  memberId: string;
  response: AuthenticationResponseJSON;
  rp: WebAuthnRelyingParty;
  now?: Date;
  store?: PasskeyStorePathOptions;
}): Promise<{
  purpose: PasskeyStepUpPurpose;
  target?: string;
  credentialId: string;
  /** Single use; only this browser holds it. The change must present it. */
  stepUpToken: string;
}> {
  const now = params.now ?? new Date();
  const claimed = claimPasskeyStepUp(params.memberId, now, params.store);
  const credential = usableCredentialOf(params.memberId, params.response, now, params.store);
  await verifyAssertion(params, credential, claimed.challenge, now);
  const stepUpToken = markPasskeyStepUpVerified(
    params.memberId,
    claimed,
    credential.credential_id,
    now,
    params.store
  );
  return {
    purpose: claimed.purpose,
    ...(claimed.target ? { target: claimed.target } : {}),
    credentialId: credential.credential_id,
    stepUpToken,
  };
}

export interface PasskeyRevocation {
  credentialId: string;
  /** The usable passkey whose step-up authorized the revoke, if one was needed. */
  steppedUpWith?: string;
  /** The removed passkey was still in its enrollment cooldown. */
  wasCoolingDown: boolean;
}

/**
 * Revoke one of the member's passkeys, deciding and removing under the
 * member's lock. While the member has a usable passkey this spends a step-up
 * confirmed for exactly this revoke (with its token); with none usable (only
 * cooling-down enrollments, e.g. one a stolen session added) the signed-in
 * member may revoke without one. Null when no such passkey.
 */
export function revokeMemberPasskey(params: {
  memberId: string;
  credentialId: string;
  stepUpToken?: string;
  now?: Date;
  store?: PasskeyStorePathOptions;
}): PasskeyRevocation | null {
  const now = params.now ?? new Date();
  if (!readPasskeyCredentialFile(params.memberId, params.store)) return null;
  return updatePasskeyCredentialFile(params.memberId, params.store ?? {}, (current) => {
    const target = current.credentials.find((entry) => entry.credential_id === params.credentialId);
    if (!target) return { result: null };
    let file = current;
    let steppedUpWith: string | undefined;
    if (current.credentials.some((entry) => isPasskeyUsable(entry, now))) {
      const spent = spendPasskeyStepUp(params.memberId, current, {
        purpose: 'revoke',
        target: params.credentialId,
        token: params.stepUpToken,
        now,
      });
      file = spent.rest;
      steppedUpWith = spent.credentialId;
    }
    return {
      next: {
        ...file,
        credentials: file.credentials.filter(
          (entry) => entry.credential_id !== params.credentialId
        ),
      },
      result: {
        credentialId: params.credentialId,
        ...(steppedUpWith ? { steppedUpWith } : {}),
        wasCoolingDown: !isPasskeyUsable(target, now),
      },
    };
  });
}

function notUsableYet(credential: PasskeyCredential): never {
  refuse(
    `passkey '${credential.label}' is in its enrollment cooldown and can approve A3 requests from ${credential.usable_after}`,
    credential.credential_id
  );
}

/** The member's own registered passkey that answered, past its cooldown. */
function usableCredentialOf(
  memberId: string,
  response: AuthenticationResponseJSON,
  now: Date,
  store: PasskeyStorePathOptions | undefined
): PasskeyCredential {
  const credentialId = typeof response?.id === 'string' ? response.id : '';
  const credential = credentialId ? findPasskeyCredential(memberId, credentialId, store) : null;
  if (!credential)
    refuse('passkey is not registered to the deciding member', credentialId || 'no id');
  if (!isPasskeyUsable(credential, now)) notUsableYet(credential);
  return credential;
}

/** Verify the assertion over `expectedChallenge` (UV required) and persist the advanced counter. */
async function verifyAssertion(
  params: {
    memberId: string;
    response: AuthenticationResponseJSON;
    rp: WebAuthnRelyingParty;
    store?: PasskeyStorePathOptions;
  },
  credential: PasskeyCredential,
  expectedChallenge: string,
  now: Date
): Promise<void> {
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge,
      expectedOrigin: params.rp.origin,
      expectedRPID: params.rp.rpId,
      credential: {
        id: credential.credential_id,
        publicKey: toBytes(credential.public_key),
        counter: credential.counter,
        transports: transportsOf(credential.transports),
      },
      requireUserVerification: true,
    });
  } catch (error) {
    refuse('assertion did not verify', error instanceof Error ? error.message : String(error));
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    refuse('assertion did not verify', 'verified=false');
  }
  recordPasskeyUse(
    params.memberId,
    credential.credential_id,
    verification.authenticationInfo.newCounter,
    now,
    params.store
  );
}

/** Issue the approval challenge and the browser's `navigator.credentials.get` options. */
export async function createApprovalPasskeyOptions(
  role: GovernedArtifactRole,
  params: {
    record: ApprovalRequestRecord;
    storageChannel: string;
    decision: ApprovalPasskeyDecision;
    memberId: string;
    /** The digest of the card the member was shown (HA-06). */
    presentedDigest: string;
    rp: WebAuthnRelyingParty;
    now?: Date;
    store?: PasskeyStorePathOptions;
  }
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const registered = readPasskeyCredentialFile(params.memberId, params.store)?.credentials ?? [];
  if (!registered.length) {
    throw new Error(
      `[POLICY_VIOLATION] member '${params.memberId}' has no registered passkey ` +
        '| next: register one under Settings › Profile › Passkeys, then approve again'
    );
  }
  const now = params.now ?? new Date();
  const credentials = registered.filter((entry) => isPasskeyUsable(entry, now));
  if (!credentials.length) {
    const soonest = [...registered].sort((a, b) =>
      String(a.usable_after).localeCompare(String(b.usable_after))
    )[0];
    notUsableYet(soonest);
  }
  const challenge = issueApprovalPasskeyChallenge(role, params);
  const options = await generateAuthenticationOptions({
    rpID: params.rp.rpId,
    challenge: toBytes(challenge.challenge),
    timeout: APPROVAL_PASSKEY_CHALLENGE_TTL_MS,
    userVerification: 'required',
    allowCredentials: credentials.map((entry) => ({
      id: entry.credential_id,
      transports: transportsOf(entry.transports),
    })),
  });
  return { challengeId: challenge.challenge_id, options };
}

export interface VerifiedApprovalPasskey {
  challengeId: string;
  presentedDigest: string;
  credentialId: string;
}

/**
 * Verify the member's assertion over the approval challenge. The challenge is
 * claimed first, so it is checked at most once whatever the outcome.
 */
export async function verifyApprovalPasskeyAssertion(
  role: GovernedArtifactRole,
  params: {
    challengeId: string;
    storageChannel: string;
    requestId: string;
    decision: ApprovalPasskeyDecision;
    memberId: string;
    response: AuthenticationResponseJSON;
    rp: WebAuthnRelyingParty;
    now?: Date;
    store?: PasskeyStorePathOptions;
  }
): Promise<VerifiedApprovalPasskey> {
  const now = params.now ?? new Date();
  const claimed = claimApprovalPasskeyChallenge(role, { ...params, now });
  const credential = usableCredentialOf(params.memberId, params.response, now, params.store);
  await verifyAssertion(params, credential, claimed.challenge, now);
  markApprovalPasskeyChallengeVerified(role, claimed, credential.credential_id, now);
  return {
    challengeId: claimed.challenge_id,
    presentedDigest: claimed.presented_digest,
    credentialId: credential.credential_id,
  };
}
