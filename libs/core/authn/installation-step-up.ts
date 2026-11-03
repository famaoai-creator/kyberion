/**
 * Recent passkey step-up for installation-scope writes (installation-owner
 * authorization model, knowledge/product/governance/installation-owner-authorization.md).
 *
 * A change to settings of the whole machine from a non-loopback browser needs
 * the installation owner to have confirmed with a usable passkey within a
 * short window. The confirmation reuses the HA-07 step-up ceremony
 * (passkey-step-up.ts) with purpose `installation`; once verified, the
 * single-use step-up is spent and replaced by ONE server-side record:
 *
 *   { session_hash: sha256(binding), verified_at, credential_id }
 *
 * stored in the member's passkey file (so it is bound to the member) and
 * matched against the session binding the adapter derives from the request
 * credential (so another session of the same member cannot use it). The
 * record never leaves the server; the browser only learns when it lapses.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isPasskeyUsable,
  readPasskeyCredentialFile,
  updatePasskeyCredentialFile,
  type PasskeyStorePathOptions,
} from './passkey-credential-store.js';
import { spendPasskeyStepUp } from './passkey-step-up.js';

/** How long one installation step-up authorizes writes from the confirming session. */
export const INSTALLATION_STEP_UP_WINDOW_MS = 5 * 60_000;

function hashBinding(binding: string): string {
  return createHash('sha256')
    .update(`kyberion-installation-step-up-v1\n${binding}`)
    .digest('base64url');
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Spend the member's verified `installation` step-up (token from
 * `verifyPasskeyStepUp`) and record it for `sessionBinding`. Throws a
 * `[POLICY_VIOLATION]` refusal when the step-up is missing, stale, for another
 * purpose, or the token does not match.
 */
export function recordInstallationStepUp(
  memberId: string,
  params: { sessionBinding: string; stepUpToken: string; now?: Date },
  options: PasskeyStorePathOptions = {}
): { verifiedAt: string; expiresAt: string; credentialId: string } {
  const now = params.now ?? new Date();
  if (!params.sessionBinding.trim()) {
    throw new Error(
      '[POLICY_VIOLATION] installation step-up refused — no session to bind it to ' +
        '| next: sign in from this browser and confirm again | evidence: ' +
        memberId
    );
  }
  return updatePasskeyCredentialFile(memberId, options, (current) => {
    const { rest, credentialId } = spendPasskeyStepUp(memberId, current, {
      purpose: 'installation',
      token: params.stepUpToken,
      now,
    });
    const verifiedAt = now.toISOString();
    return {
      next: {
        ...rest,
        installation_step_up: {
          session_hash: hashBinding(params.sessionBinding),
          verified_at: verifiedAt,
          credential_id: credentialId,
        },
      },
      result: {
        verifiedAt,
        expiresAt: new Date(now.getTime() + INSTALLATION_STEP_UP_WINDOW_MS).toISOString(),
        credentialId,
      },
    };
  });
}

/**
 * When the member's installation step-up for this session was verified, or
 * null when there is none, it belongs to another session, it is older than
 * `windowMs`, or the confirming passkey is no longer registered and usable.
 */
export function readFreshInstallationStepUp(
  memberId: string,
  sessionBinding: string | undefined,
  params: { now?: Date; windowMs?: number } = {},
  options: PasskeyStorePathOptions = {}
): string | null {
  if (!sessionBinding?.trim()) return null;
  const now = params.now ?? new Date();
  const windowMs = params.windowMs ?? INSTALLATION_STEP_UP_WINDOW_MS;
  const file = readPasskeyCredentialFile(memberId, options);
  const record = file?.installation_step_up;
  if (!file || !record) return null;
  if (!sameHash(record.session_hash, hashBinding(sessionBinding))) return null;
  const verified = Date.parse(record.verified_at);
  if (!Number.isFinite(verified) || verified > now.getTime()) return null;
  if (now.getTime() - verified > windowMs) return null;
  const confirming = file.credentials.find((entry) => entry.credential_id === record.credential_id);
  if (!confirming || !isPasskeyUsable(confirming, now)) return null;
  return record.verified_at;
}
