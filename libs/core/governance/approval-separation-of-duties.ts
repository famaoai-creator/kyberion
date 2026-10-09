/**
 * Separation of duties for approval decisions (`approval-policy.json`
 * `separation_of_duties`, default off): identity normalisation, the pure
 * check, and `assertApprovalUsable` — the one check every consumer runs
 * before turning an approved record into an effect. The decide-time
 * enforcement lives in `approval-store.ts` (it also writes the channel event
 * log); everything here is re-exported from there.
 */
import { auditChain } from './audit-chain.js';
import { resolveSeparationOfDutiesPolicy } from './approval-policy.js';
import type { ApprovalRequestRecord } from './approval-store.js';

/**
 * Principal-type prefixes surfaces put in front of an identity
 * (`user:<member_id>` from chronos / presence-studio, `agent:…`, `service:…`).
 * They are stripped before comparison so `user:alice` and `alice` count as the
 * same principal. Because the requester controls `requestedBy`, a requester
 * can also make a later decider look like themselves (false positive); that
 * only refuses a decision, which is the safe direction.
 */
const APPROVAL_PRINCIPAL_PREFIX =
  /^(?:user|human|operator|member|principal|agent|service|persona|actor|policy):/;

/** Canonical form of an approval principal id for identity comparison. */
export function normalizeApprovalPrincipalId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().toLowerCase().replace(APPROVAL_PRINCIPAL_PREFIX, '').trim();
}

/**
 * Decider ids that surfaces fall back to when they could not resolve who
 * decided (`concierge` and `chronos-localadmin` without a session member,
 * `sovereign-user` from `resolveOperatorDisplayName` without an onboarding
 * identity, …). They name a surface, not a person, so under separation of
 * duties they count as "no decider". This is the single list; compare after
 * {@link normalizeApprovalPrincipalId}.
 */
export const APPROVAL_PLACEHOLDER_DECIDERS: ReadonlySet<string> = new Set([
  'concierge',
  'chronos-localadmin',
  'sovereign-user',
  'cowork-operator',
  'mcp-client',
  'operator',
  'sovereign',
  'human',
  'user',
  'unknown',
  'unknown-human',
  'anonymous',
]);

/**
 * How the surface obtained the decider identity it records. `caller_supplied`
 * marks a surface that takes the decider as free text from its caller (the
 * MCP `kyberion.approval.decide` tool, the approval-actuator `decide` op), so
 * the identity is a claim, not something the server resolved. Unmarked
 * decisions come from surfaces that resolve the decider themselves.
 */
export type ApprovalDeciderIdentitySource = 'server_resolved' | 'caller_supplied';

/**
 * Every identity a request records for whoever asked for it: `requestedBy`,
 * the structured `requestedByContext.actorId`, and the originating
 * `source.agentId`. Normalised and de-duplicated; empty when none is present.
 */
export function approvalRequesterIdentities(
  record: Pick<ApprovalRequestRecord, 'requestedBy' | 'requestedByContext' | 'source'>
): string[] {
  const ids = [record.requestedBy, record.requestedByContext?.actorId, record.source?.agentId]
    .map(normalizeApprovalPrincipalId)
    .filter(Boolean);
  return Array.from(new Set(ids));
}

export type SeparationOfDutiesViolation =
  'self_approval' | 'missing_requester' | 'missing_decider' | 'unverified_decider';

/**
 * Pure separation-of-duties check for one decider. Returns the violation, or
 * `null` when the decider is a server-resolved, non-placeholder principal
 * different from every recorded requester. A request with no recorded
 * requester (or a decision with no real decider) cannot be proven separate,
 * so it is a violation — fail closed.
 */
export function evaluateSeparationOfDuties(
  record: Pick<ApprovalRequestRecord, 'requestedBy' | 'requestedByContext' | 'source'>,
  decidedBy: unknown,
  identitySource?: ApprovalDeciderIdentitySource
): SeparationOfDutiesViolation | null {
  if (identitySource === 'caller_supplied') return 'unverified_decider';
  const decider = normalizeApprovalPrincipalId(decidedBy);
  if (!decider || APPROVAL_PLACEHOLDER_DECIDERS.has(decider)) return 'missing_decider';
  const requesters = approvalRequesterIdentities(record);
  if (requesters.length === 0) return 'missing_requester';
  return requesters.includes(decider) ? 'self_approval' : null;
}

export const SEPARATION_OF_DUTIES_MESSAGES: Record<SeparationOfDutiesViolation, string> = {
  self_approval: 'the decider is the same principal that requested it',
  missing_requester: 'the request records no requester identity, so separation cannot be proven',
  missing_decider:
    'the decision carries no real decider identity (empty or a surface placeholder), so separation cannot be proven',
  unverified_decider:
    'the decider identity was supplied by the caller, not resolved by the server, so separation cannot be proven',
};

/**
 * Every approving decision a record carries: the record-level decider plus
 * each approved workflow stage (a staged workflow is decided per role).
 */
function approvingDecisions(
  record: ApprovalRequestRecord
): Array<{ decidedBy: unknown; identitySource?: ApprovalDeciderIdentitySource }> {
  const decisions: Array<{ decidedBy: unknown; identitySource?: ApprovalDeciderIdentitySource }> = [
    { decidedBy: record.decidedBy, identitySource: record.decidedByIdentitySource },
  ];
  for (const approval of record.workflow?.approvals ?? []) {
    if (approval.status !== 'approved') continue;
    decisions.push({
      decidedBy: approval.approvedBy,
      identitySource: approval.deciderIdentitySource,
    });
  }
  return decisions;
}

/** Whether `approval-policy.json` `separation_of_duties` is on (fails closed on an unreadable policy). */
export function isSeparationOfDutiesEnabled(): boolean {
  return resolveSeparationOfDutiesPolicy().enabled;
}

/**
 * Whether an already-approved record may be turned into an effect under the
 * current separation-of-duties setting. `null` when usable (or the setting is
 * off); otherwise the violation and the decider it concerns.
 */
export function evaluateApprovalUsability(
  record: ApprovalRequestRecord,
  /** The consumer asking (registry: approval-sod-consumers.contract.test.ts); not audited. */
  _context?: { consumer: string }
): { violation: SeparationOfDutiesViolation; decidedBy: string } | null {
  if (!resolveSeparationOfDutiesPolicy().enabled) return null;
  for (const decision of approvingDecisions(record)) {
    const violation = evaluateSeparationOfDuties(
      record,
      decision.decidedBy,
      decision.identitySource
    );
    if (violation) {
      return {
        violation,
        decidedBy: typeof decision.decidedBy === 'string' ? decision.decidedBy : '',
      };
    }
  }
  return null;
}

export function auditSeparationOfDutiesRefusal(params: {
  record: ApprovalRequestRecord;
  violation: SeparationOfDutiesViolation;
  decidedBy: string;
  stage: string;
  reason: string;
}): void {
  const { record } = params;
  auditChain.record({
    agentId: 'approval-store',
    action: 'approval_decision',
    operation: 'separation_of_duties',
    result: 'denied',
    reason: params.reason,
    correlationId: record.correlationId,
    metadata: {
      requestId: record.id,
      channel: record.channel,
      stage: params.stage,
      violation: params.violation,
      decidedBy: params.decidedBy,
      requestedBy: record.requestedBy,
      requesterIdentities: approvalRequesterIdentities(record),
    },
  });
}

/**
 * The one check every consumer runs before turning an approved record into an
 * effect (approval gate, project trust, DOT release, plugin view execute, MCP
 * governed tools, pipeline approval steps, apply claims, …). With
 * `separation_of_duties` off it is a no-op. With it on, a record whose
 * approving decision fails the separation check — e.g. a self-approval
 * recorded while the setting was off — is refused with `[POLICY_VIOLATION]`
 * and audited. The record itself is left as it is; the message says how to get
 * a usable approval.
 *
 * @param options.consumer  short name of the caller, recorded in the audit.
 * @param options.rerequestCommand  exact command that opens a fresh request,
 *   when the caller knows it.
 */
export function assertApprovalUsable(
  record: ApprovalRequestRecord,
  options: {
    consumer: string;
    rerequestCommand?: string;
    /** Replaces the default "how to get a new approval" sentence. */
    rerequestHint?: string;
  }
): void {
  const refusal = evaluateApprovalUsability(record);
  if (!refusal) return;
  const reason = `Separation of duties: approval ${record.id} cannot be used because ${SEPARATION_OF_DUTIES_MESSAGES[refusal.violation]}`;
  const next =
    options.rerequestHint ??
    (options.rerequestCommand
      ? `request a new approval with \`${options.rerequestCommand}\``
      : 'request a new approval by re-running the command that opened this one');
  const message =
    `[POLICY_VIOLATION] ${reason}. This approval is ${record.status} and can no longer be cancelled or used; ` +
    `it is never reused — ${next}, then have a different, server-identified principal decide it ` +
    '(`pnpm kyberion approvals --approve <new-request-id>`).';
  // The audit carries the full message, so the operator's next step is in
  // the audit trail too (held actions settle without surfacing an error).
  auditSeparationOfDutiesRefusal({
    record,
    violation: refusal.violation,
    decidedBy: refusal.decidedBy,
    stage: `use:${options.consumer}`,
    reason: message,
  });
  throw new Error(message);
}

/**
 * The refusal message when an approved record is not usable (audited via
 * {@link assertApprovalUsable}), else undefined. For consumers that report a
 * reason or fall back instead of throwing.
 */
export function approvalUsabilityRefusal(
  record: ApprovalRequestRecord | null | undefined,
  consumer: string
): string | undefined {
  if (!record) return undefined;
  try {
    assertApprovalUsable(record, { consumer });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
