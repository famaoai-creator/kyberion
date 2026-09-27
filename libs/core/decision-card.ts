import {
  AUTONOMOUS_OPS_SHADOW_REASON,
  type AutonomousOpsDecision,
  type AutonomousOpsGateResult,
} from './autonomous-ops-gate.js';

/**
 * The decision card — one screen that tells the
 * operator what to decide, what the agent recommends, how risky it is and
 * why, whether it can be undone, by when, and where the evidence is.
 *
 * The card is display data attached to an approval request; the approval
 * store's status stays the only record of the decision.
 */

export type DecisionCardTier = AutonomousOpsDecision;

export interface DecisionCardEvidence {
  label: string;
  /** `https://` URL or repository-relative path. */
  ref: string;
}

export interface DecisionCard {
  question: string;
  recommendation: string;
  riskTier: DecisionCardTier;
  riskReasons: string[];
  reversible: boolean;
  deadline?: string;
  evidence: DecisionCardEvidence[];
}

export const DECISION_CARD_LIMITS = {
  text: 1000,
  reasons: 10,
  evidence: 10,
} as const;

const TIER_RANK: Record<DecisionCardTier, number> = { auto: 0, notify: 1, approve: 2 };

function isTier(value: unknown): value is DecisionCardTier {
  return typeof value === 'string' && Object.hasOwn(TIER_RANK, value);
}

function isEvidenceRef(ref: string): boolean {
  if (/^https:\/\/[^\s]+$/u.test(ref)) return true;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(ref) || ref.startsWith('/') || ref.includes('\\')) return false;
  return ref.split('/').every((segment) => segment !== '' && segment !== '..');
}

function clipText(value: string): string {
  return value.length > DECISION_CARD_LIMITS.text
    ? `${value.slice(0, DECISION_CARD_LIMITS.text - 1)}…`
    : value;
}

function assertText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[DECISION_CARD] ${field} must be a non-empty string`);
  }
  if (value.length > DECISION_CARD_LIMITS.text) {
    throw new Error(`[DECISION_CARD] ${field} exceeds ${DECISION_CARD_LIMITS.text} characters`);
  }
}

/** Throws when the card is malformed; returns it unchanged otherwise. */
export function validateDecisionCard(card: DecisionCard): DecisionCard {
  assertText(card.question, 'question');
  assertText(card.recommendation, 'recommendation');
  if (!isTier(card.riskTier)) throw new Error('[DECISION_CARD] riskTier is invalid');
  if (typeof card.reversible !== 'boolean') {
    throw new Error('[DECISION_CARD] reversible must be a boolean');
  }
  if (!Array.isArray(card.riskReasons) || card.riskReasons.length > DECISION_CARD_LIMITS.reasons) {
    throw new Error(`[DECISION_CARD] riskReasons must be at most ${DECISION_CARD_LIMITS.reasons}`);
  }
  card.riskReasons.forEach((reason, index) => assertText(reason, `riskReasons[${index}]`));
  if (card.deadline !== undefined && Number.isNaN(Date.parse(card.deadline))) {
    throw new Error('[DECISION_CARD] deadline must be a parseable date');
  }
  if (!Array.isArray(card.evidence) || card.evidence.length > DECISION_CARD_LIMITS.evidence) {
    throw new Error(`[DECISION_CARD] evidence must be at most ${DECISION_CARD_LIMITS.evidence}`);
  }
  card.evidence.forEach((item, index) => {
    assertText(item?.label, `evidence[${index}].label`);
    assertText(item?.ref, `evidence[${index}].ref`);
    if (!isEvidenceRef(item.ref)) {
      throw new Error(
        `[DECISION_CARD] evidence[${index}].ref must be an https URL or repository-relative path`
      );
    }
  });
  return card;
}

/**
 * Build a card, optionally from an autonomous-ops gate result. The tier is
 * the stricter of the gate's and the caller's, and defaults to `approve`;
 * the action counts as reversible only when every source says so.
 */
export function buildDecisionCard(input: {
  question: string;
  recommendation: string;
  gate?: Pick<AutonomousOpsGateResult, 'decision' | 'reason' | 'axes' | 'score'>;
  riskTier?: DecisionCardTier;
  riskReasons?: string[];
  reversible?: boolean;
  deadline?: string;
  evidence?: DecisionCardEvidence[];
}): DecisionCard {
  const tiers = [input.gate?.decision, input.riskTier].filter(isTier);
  const riskTier =
    tiers.length === 0 ? 'approve' : tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
  const gateReasons = input.gate
    ? input.gate.reason
        .split('; ')
        .map((reason) => reason.trim())
        .filter((reason) => reason && reason !== AUTONOMOUS_OPS_SHADOW_REASON)
    : [];
  const reversibleVotes = [
    input.reversible,
    input.gate ? Number.isFinite(input.gate.score) && input.gate.axes.reversibility < 2 : undefined,
  ].filter((vote): vote is boolean => typeof vote === 'boolean');
  return validateDecisionCard({
    question: input.question.trim(),
    recommendation: input.recommendation.trim(),
    riskTier,
    riskReasons: [...(input.riskReasons ?? []), ...gateReasons]
      .map((reason) => clipText(reason.trim()))
      .filter(Boolean)
      .slice(0, DECISION_CARD_LIMITS.reasons),
    reversible: reversibleVotes.length > 0 && reversibleVotes.every(Boolean),
    ...(input.deadline ? { deadline: input.deadline } : {}),
    evidence: input.evidence ?? [],
  });
}
