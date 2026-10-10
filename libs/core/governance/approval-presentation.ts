/**
 * HA-06: bind a decision to what the decider was shown.
 *
 * A surface computes the presented digest of a request when it renders the
 * decision (the action, its target and the effect it binds) and sends it back
 * with the decision. The store recomputes it from the stored record, so a
 * decision taken on a view of a request that has since changed — another
 * effect hash, another target, another summary — is refused instead of being
 * matched against the record's own values.
 *
 * The digest covers everything a surface displays — see
 * `computeApprovalPresentedDigest` for the audited renderers and the
 * deliberate exclusions — plus `accountability.payloadHash` /
 * `effectBinding`, so a verified digest
 * binds the decision both to what was read and to the requested effect.
 *
 * Chat bridges carry a compact prefix in the card action id (Telegram limits
 * callback data to 64 bytes) and expand it on their own callback path
 * (`resolveCompactPresentedDigest`); the store and every other surface accept
 * only the full digest.
 */
import { createHash } from 'node:crypto';
import type { ApprovalRequestRecord } from './approval-store.js';

/** Stable SHA-256 fingerprint for binding an approval to its exact effect payload. */
export function computeApprovalPayloadHash(payload: Record<string, unknown> | undefined): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload || {})))
    .digest('hex');
}

/** Hex length of the digest prefix chat bridges embed in card action ids. */
export const APPROVAL_PRESENTED_DIGEST_COMPACT_LENGTH = 12;
const FULL_DIGEST_LENGTH = 64;

export type ApprovalPresentationSubject = Pick<
  ApprovalRequestRecord,
  | 'id'
  | 'title'
  | 'summary'
  | 'details'
  | 'target'
  | 'accountability'
  | 'scope'
  | 'kind'
  | 'channel'
  | 'severity'
  | 'sourceText'
  | 'requestedAt'
  | 'expiresAt'
  | 'requestedBy'
  | 'requestedByDisplayName'
  | 'requestedByContext'
  | 'justification'
  | 'risk'
  | 'track_id'
  | 'track_name'
  | 'work_loop'
  | 'decisionCard'
  | 'veto'
  | 'workflow'
  | 'steering'
>;

/** The workflow shape fixed at creation; `approvals` is the role progress. */
function presentedWorkflow(workflow: ApprovalPresentationSubject['workflow']) {
  if (!workflow) return null;
  return {
    workflow_id: workflow.workflowId,
    mode: workflow.mode,
    required_roles: workflow.requiredRoles,
    stages: workflow.stages,
  };
}

/** What a steering request will do; reply routing (surface, thread, correlation) is excluded. */
function presentedSteering(steering: ApprovalPresentationSubject['steering']) {
  if (!steering) return null;
  if (steering.kind === 'mission_lifecycle_verb') {
    return {
      kind: steering.kind,
      verb: steering.verb,
      mission_id: steering.missionId,
      note: steering.note ?? null,
    };
  }
  return {
    kind: steering.kind,
    held_action_id: steering.heldActionId,
    op: steering.op,
    mission_id: steering.missionId,
    tenant: steering.tenantSlug ?? null,
    note: steering.note ?? null,
    effect_binding: steering.effectBinding,
    payload_hash: steering.payloadHash,
  };
}

/** The decision-card fields surfaces render (delivery bookkeeping is excluded). */
function presentedDecisionCard(card: ApprovalPresentationSubject['decisionCard']) {
  if (!card) return null;
  return {
    question: card.question,
    recommendation: card.recommendation,
    risk_tier: card.riskTier,
    risk_reasons: card.riskReasons,
    reversible: card.reversible,
    deadline: card.deadline ?? null,
    evidence: card.evidence,
    level: card.level ?? null,
    shadow: card.shadow ?? null,
  };
}

/**
 * The presented digest of a request: everything a surface shows the decider.
 * Audited renderers: Chronos (approvals workspace, mission intelligence),
 * Concierge (decide queue), Presence Studio (approval inbox), Slack blocks,
 * the chat text / decision card and the CLI challenge. `work_loop` and
 * `requestedByContext` are hashed whole: both are fixed at creation, and
 * Chronos derives the request's tenant and project from them. Left out on
 * purpose: values that change while the request is pending (`workflow`
 * approvals and current stage, veto delivery times and the "if no response"
 * text derived from them, `status`, which a decision requires to be pending
 * anyway) and context that is not part of the record (the turn's intent
 * contract, distilled titles, a tenant read from mission state).
 */
export function computeApprovalPresentedDigest(record: ApprovalPresentationSubject): string {
  return computeApprovalPayloadHash({
    request_id: record.id,
    kind: record.kind ?? null,
    channel: record.channel ?? null,
    action: record.title,
    summary: record.summary,
    details: record.details ?? null,
    severity: record.severity ?? null,
    source_text: record.sourceText ?? null,
    requested_at: record.requestedAt ?? null,
    expires_at: record.expiresAt ?? null,
    target: record.target ?? null,
    tenant: record.scope?.tenant_slug ?? null,
    organization: record.scope?.organization_id ?? null,
    requested_by: record.requestedBy ?? null,
    requested_by_display_name: record.requestedByDisplayName ?? null,
    requested_by_context: record.requestedByContext ?? null,
    justification: record.justification ?? null,
    risk: record.risk ?? null,
    track: { id: record.track_id ?? null, name: record.track_name ?? null },
    work_loop: record.work_loop ?? null,
    workflow: presentedWorkflow(record.workflow),
    steering: presentedSteering(record.steering),
    veto: record.veto
      ? { window_minutes: record.veto.windowMinutes, shadow: record.veto.shadow ?? null }
      : null,
    decision_card: presentedDecisionCard(record.decisionCard),
    effect: {
      final_decision: record.accountability?.finalDecision ?? null,
      payload_hash: record.accountability?.payloadHash ?? null,
      effect_binding: record.accountability?.effectBinding ?? null,
    },
  });
}

/** The prefix a chat card action id carries (see the module comment). */
export function compactApprovalPresentedDigest(record: ApprovalPresentationSubject): string {
  return computeApprovalPresentedDigest(record).slice(0, APPROVAL_PRESENTED_DIGEST_COMPACT_LENGTH);
}

/**
 * The binding fields a surface sends with a decision: the presented digest it
 * rendered when the client sent one back, else (legacy clients, warn rollout)
 * the record's own hashes, which the store audits as unpresented.
 */
export function surfaceDecisionBinding(
  record: Pick<ApprovalRequestRecord, 'accountability'>,
  presentedDigest: unknown
): { presentedDigest: string } | { payloadHash?: string; effectBinding?: string } {
  if (typeof presentedDigest === 'string' && presentedDigest.trim()) {
    return { presentedDigest: presentedDigest.trim() };
  }
  return {
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
  };
}

/**
 * True when `presented` is the record's full digest. The compact prefix is
 * accepted only with `allowCompact`, which only the chat-bridge callback path
 * passes (see `resolveCompactPresentedDigest`).
 */
export function approvalPresentedDigestMatches(
  record: ApprovalPresentationSubject,
  presented: string,
  options: { allowCompact?: boolean } = {}
): boolean {
  const value = presented.trim().toLowerCase();
  if (!/^[0-9a-f]+$/u.test(value)) return false;
  const lengthOk =
    value.length === FULL_DIGEST_LENGTH ||
    (options.allowCompact === true && value.length === APPROVAL_PRESENTED_DIGEST_COMPACT_LENGTH);
  if (!lengthOk) return false;
  return computeApprovalPresentedDigest(record).startsWith(value);
}

/**
 * Chat-bridge callback path only: a card token's compact digest becomes the
 * record's full digest when it matches, else null. The store then re-checks
 * the full digest against the record it decides under its lock.
 */
export function resolveCompactPresentedDigest(
  record: ApprovalPresentationSubject,
  presented: string
): string | null {
  return approvalPresentedDigestMatches(record, presented, { allowCompact: true })
    ? computeApprovalPresentedDigest(record)
    : null;
}
