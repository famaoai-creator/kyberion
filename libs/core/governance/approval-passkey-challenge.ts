/**
 * HA-07: the server-side challenge a passkey assertion signs to settle one
 * approval decision.
 *
 * The WebAuthn challenge is `base64url(sha256(binding))`, where the binding
 * names the request id, the decision, the presented digest of the request
 * (approval-presentation.ts), the expiry and a random nonce. The surface sends
 * the digest of the card it displayed, and a challenge is issued only when
 * that digest matches the request as stored now — so the assertion signs
 * exactly what the decider was shown, for one request and one decision,
 * before a short deadline.
 *
 * Each challenge is stored beside the request it binds (the approval store's
 * coordination root) and moves through `issued → claimed → verified →
 * consumed`, each step at most once: the verifier claims it before checking
 * the assertion (so a challenge is presented once, whatever the outcome), and
 * the approval store consumes it under the request lock when it records the
 * `passkey` decision. A store decision declaring `passkey` without a verified,
 * unconsumed challenge for the same member, request, decision and digest is
 * refused.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withLockSync } from '../lock-utils.js';
import {
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { approvalStoreRoots } from './approval-store-paths.js';
import {
  approvalPresentedDigestMatches,
  computeApprovalPresentedDigest,
} from './approval-presentation.js';
import type { ApprovalRequestRecord } from './approval-store.js';

export const APPROVAL_PASSKEY_CHALLENGE_TTL_MS = 120_000;

const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ApprovalPasskeyDecision = 'approved' | 'rejected';

export interface ApprovalPasskeyChallengeRecord {
  version: 1;
  challenge_id: string;
  /** base64url(sha256(binding)) — the WebAuthn challenge. */
  challenge: string;
  nonce: string;
  request_id: string;
  storage_channel: string;
  decision: ApprovalPasskeyDecision;
  presented_digest: string;
  member_id: string;
  issued_at: string;
  expires_at: string;
  claimed_at?: string;
  verified_at?: string;
  credential_id?: string;
  consumed_at?: string;
}

type ChallengeBinding = Pick<
  ApprovalPasskeyChallengeRecord,
  'request_id' | 'decision' | 'presented_digest' | 'expires_at' | 'nonce'
>;

/** The exact bytes the challenge hashes; one field per line, versioned. */
export function approvalPasskeyChallengeBinding(binding: ChallengeBinding): string {
  return [
    'kyberion-approval-passkey-v1',
    binding.request_id,
    binding.decision,
    binding.presented_digest,
    binding.expires_at,
    binding.nonce,
  ].join('\n');
}

export function encodeApprovalPasskeyChallenge(binding: ChallengeBinding): string {
  return createHash('sha256').update(approvalPasskeyChallengeBinding(binding)).digest('base64url');
}

function refuse(reason: string, evidence: string): never {
  throw new Error(
    `[POLICY_VIOLATION] passkey approval refused — ${reason} ` +
      '| next: start the passkey approval again from the approval card ' +
      `| evidence: ${evidence}`
  );
}

function channelSegment(storageChannel: string): string {
  const channel = String(storageChannel || '')
    .trim()
    .toLowerCase();
  if (!CHANNEL_PATTERN.test(channel)) refuse('invalid approval channel', storageChannel);
  return channel;
}

function challengeLogicalPath(storageChannel: string, challengeId: string): string {
  if (!UUID_PATTERN.test(challengeId)) refuse('invalid challenge id', challengeId);
  return `${approvalStoreRoots().coordination}/${channelSegment(storageChannel)}/approvals/passkey-challenges/${challengeId.toLowerCase()}.json`;
}

function withChallengeLock<T>(storageChannel: string, challengeId: string, fn: () => T): T {
  return withLockSync(
    `approval-passkey-challenge-${channelSegment(storageChannel)}-${challengeId.toLowerCase()}`,
    fn
  );
}

function readChallenge(
  storageChannel: string,
  challengeId: string
): ApprovalPasskeyChallengeRecord {
  const record = readGovernedArtifactJson<ApprovalPasskeyChallengeRecord>(
    challengeLogicalPath(storageChannel, challengeId)
  );
  if (!record || record.version !== 1 || record.challenge_id !== challengeId.toLowerCase()) {
    refuse('unknown challenge', challengeId);
  }
  // A record edited on disk no longer hashes to its own challenge.
  if (record.challenge !== encodeApprovalPasskeyChallenge(record)) {
    refuse('challenge does not match its binding', challengeId);
  }
  return record;
}

interface ChallengeExpectation {
  storageChannel: string;
  challengeId: string;
  requestId: string;
  memberId: string;
  decision: ApprovalPasskeyDecision;
  now?: Date;
}

function assertExpectation(
  record: ApprovalPasskeyChallengeRecord,
  expected: ChallengeExpectation
): void {
  if (record.request_id !== expected.requestId) {
    refuse(
      'challenge was issued for another request',
      `${record.request_id} ≠ ${expected.requestId}`
    );
  }
  if (record.member_id !== expected.memberId) {
    refuse('challenge was issued to another member', `challenge ${record.challenge_id}`);
  }
  if (record.decision !== expected.decision) {
    refuse(
      'challenge was issued for the other decision',
      `${record.decision} ≠ ${expected.decision}`
    );
  }
  const now = (expected.now ?? new Date()).getTime();
  if (Date.parse(record.expires_at) <= now) {
    refuse('challenge expired', `expires_at ${record.expires_at}`);
  }
}

/**
 * Whether the store still takes a decision on `record`: pending, or settled
 * while a staged / multi-role workflow still owes another role's decision
 * (the same rule as `decideApprovalRequest`).
 */
function acceptsDecision(record: ApprovalRequestRecord): boolean {
  if (record.status === 'pending') return true;
  if (!['approved', 'rejected', 'applied'].includes(record.status)) return false;
  return (record.workflow?.approvals ?? []).some((approval) => approval.status === 'pending');
}

/**
 * Issue a challenge for `memberId` to approve or reject `record`, bound to the
 * `presentedDigest` of the card the member was shown — refused when that no
 * longer matches the stored request. Expires after the TTL, or with the
 * request if that comes first.
 */
export function issueApprovalPasskeyChallenge(
  role: GovernedArtifactRole,
  params: {
    record: ApprovalRequestRecord;
    storageChannel: string;
    decision: ApprovalPasskeyDecision;
    memberId: string;
    presentedDigest: string;
    now?: Date;
  }
): ApprovalPasskeyChallengeRecord {
  const { record } = params;
  if (!acceptsDecision(record)) {
    refuse('request no longer takes a decision', `${record.id} ${record.status}`);
  }
  if (
    typeof params.presentedDigest !== 'string' ||
    !approvalPresentedDigestMatches(record, params.presentedDigest)
  ) {
    throw new Error(
      `[POLICY_VIOLATION] passkey approval refused — request ${record.id} changed since it was shown to the decider ` +
        '| next: reload the request and decide on what it says now ' +
        `| evidence: current ${computeApprovalPresentedDigest(record).slice(0, 16)}…`
    );
  }
  const now = params.now ?? new Date();
  let expiresAtMs = now.getTime() + APPROVAL_PASSKEY_CHALLENGE_TTL_MS;
  if (record.expiresAt) expiresAtMs = Math.min(expiresAtMs, Date.parse(record.expiresAt));
  if (!(expiresAtMs > now.getTime())) refuse('request has expired', record.id);
  const binding: ChallengeBinding = {
    request_id: record.id,
    decision: params.decision,
    presented_digest: computeApprovalPresentedDigest(record),
    expires_at: new Date(expiresAtMs).toISOString(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const challenge: ApprovalPasskeyChallengeRecord = {
    version: 1,
    challenge_id: randomUUID(),
    challenge: encodeApprovalPasskeyChallenge(binding),
    storage_channel: channelSegment(params.storageChannel),
    member_id: params.memberId,
    issued_at: now.toISOString(),
    ...binding,
  };
  writeGovernedArtifactJson(
    role,
    challengeLogicalPath(params.storageChannel, challenge.challenge_id),
    challenge
  );
  return challenge;
}

/** Claim the challenge for one verification attempt; a second attempt is refused. */
export function claimApprovalPasskeyChallenge(
  role: GovernedArtifactRole,
  expected: ChallengeExpectation
): ApprovalPasskeyChallengeRecord {
  return withChallengeLock(expected.storageChannel, expected.challengeId, () => {
    const record = readChallenge(expected.storageChannel, expected.challengeId);
    if (record.claimed_at) refuse('challenge was already used', `claimed_at ${record.claimed_at}`);
    assertExpectation(record, expected);
    const claimed = { ...record, claimed_at: (expected.now ?? new Date()).toISOString() };
    writeGovernedArtifactJson(
      role,
      challengeLogicalPath(expected.storageChannel, expected.challengeId),
      claimed
    );
    return claimed;
  });
}

/** Record that the claimed challenge's assertion verified against `credentialId`. */
export function markApprovalPasskeyChallengeVerified(
  role: GovernedArtifactRole,
  claimed: ApprovalPasskeyChallengeRecord,
  credentialId: string,
  now: Date = new Date()
): ApprovalPasskeyChallengeRecord {
  return withChallengeLock(claimed.storage_channel, claimed.challenge_id, () => {
    const record = readChallenge(claimed.storage_channel, claimed.challenge_id);
    if (!record.claimed_at || record.claimed_at !== claimed.claimed_at || record.verified_at) {
      refuse('challenge changed during verification', claimed.challenge_id);
    }
    const verified = { ...record, verified_at: now.toISOString(), credential_id: credentialId };
    writeGovernedArtifactJson(
      role,
      challengeLogicalPath(claimed.storage_channel, claimed.challenge_id),
      verified
    );
    return verified;
  });
}

/**
 * The approval store's half: a `passkey` decision consumes its verified
 * challenge exactly once, for the same member (`decidedBy` = `user:<member>`),
 * request, decision and presented digest.
 */
export function consumeApprovalPasskeyChallenge(
  role: GovernedArtifactRole,
  params: {
    storageChannel: string;
    challengeId: string | undefined;
    requestId: string;
    decidedBy: string;
    decision: ApprovalPasskeyDecision;
    presentedDigest: string | undefined;
    now?: Date;
  }
): ApprovalPasskeyChallengeRecord {
  const challengeId = params.challengeId;
  if (!challengeId) {
    refuse('a passkey decision needs its verified challenge', `request ${params.requestId}`);
  }
  if (!params.decidedBy.startsWith('user:')) {
    refuse('a passkey decision must be recorded for a member', params.decidedBy);
  }
  return withChallengeLock(params.storageChannel, challengeId, () => {
    const record = readChallenge(params.storageChannel, challengeId);
    assertExpectation(record, {
      storageChannel: params.storageChannel,
      challengeId,
      requestId: params.requestId,
      memberId: params.decidedBy.slice('user:'.length),
      decision: params.decision,
      now: params.now,
    });
    if (!record.verified_at) refuse('challenge was not verified', challengeId);
    if (record.consumed_at)
      refuse('challenge was already used', `consumed_at ${record.consumed_at}`);
    if (record.presented_digest !== params.presentedDigest) {
      refuse('decision does not carry the digest the passkey signed', challengeId);
    }
    const consumed = { ...record, consumed_at: (params.now ?? new Date()).toISOString() };
    writeGovernedArtifactJson(
      role,
      challengeLogicalPath(params.storageChannel, challengeId),
      consumed
    );
    return consumed;
  });
}
