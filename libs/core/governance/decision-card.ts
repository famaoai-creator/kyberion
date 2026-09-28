import {
  AUTONOMOUS_OPS_SHADOW_REASON,
  type AutonomousOpsDecision,
  type AutonomousOpsGateResult,
} from './autonomous-ops-gate.js';
import { resolveLocale } from '../locale.js';
import type { SupportedLocale } from '../locale-normalize.js';
import type { NotificationChannelTarget } from '../surface/operator-notifications.js';
import { t } from '../t.js';

/**
 * The decision card — one screen that tells the
 * operator what to decide, what the agent recommends, how risky it is and
 * why, whether it can be undone, by when, and where the evidence is.
 *
 * The card is display data attached to an approval request; the approval
 * store's status stays the only record of the decision.
 */

export type DecisionCardTier = AutonomousOpsDecision;

/**
 * What the operator has to do (see `approval-decision-card.ts`): `decide`
 * blocks the work, `veto` proceeds unless objected to, `fyi` / `none` only
 * report. Derived from the tier when absent.
 */
export type InterventionLevel = 'none' | 'fyi' | 'veto' | 'decide';
const INTERVENTION_LEVEL_SET: ReadonlySet<string> = new Set(['none', 'fyi', 'veto', 'decide']);

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
  /** Autonomy cards: the level the gate assigned (tier + veto window). */
  level?: InterventionLevel;
  /** Shadow actions: shown, never executed. */
  shadow?: boolean;
  /** IANA timezone deadlines are shown in (the policy's active-hours timezone). */
  timezone?: string;
  /** Where an autonomy card was sent; replies are accepted only from that surface and chat. */
  deliveredVia?: NotificationChannelTarget;
  actionId?: string;
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
  if (card.level !== undefined && !INTERVENTION_LEVEL_SET.has(card.level)) {
    throw new Error('[DECISION_CARD] level is invalid');
  }
  if (card.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: card.timezone });
    } catch {
      throw new Error('[DECISION_CARD] timezone is invalid');
    }
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
  gate?: Pick<AutonomousOpsGateResult, 'decision' | 'reason' | 'axes' | 'score'> &
    Partial<GateEscalationSource>;
  riskTier?: DecisionCardTier;
  riskReasons?: string[];
  reversible?: boolean;
  deadline?: string;
  evidence?: DecisionCardEvidence[];
  level?: InterventionLevel;
  shadow?: boolean;
  timezone?: string;
  deliveredVia?: NotificationChannelTarget;
  actionId?: string;
  /** Language of the plain-language gate reasons. */
  locale?: SupportedLocale;
}): DecisionCard {
  const tiers = [input.gate?.decision, input.riskTier].filter(isTier);
  const riskTier =
    tiers.length === 0 ? 'approve' : tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a));
  const gate = input.gate;
  const gateReasons = !gate
    ? []
    : Array.isArray(gate.escalations)
      ? describeGateEscalations(
          {
            ...gate,
            escalations: gate.escalations,
            maxScore: gate.maxScore ?? 0,
            highRiskPathMatches: gate.highRiskPathMatches ?? [],
          },
          input.locale
        )
      : gate.reason
          .split('; ')
          .map((reason) => reason.trim())
          .filter((reason) => reason && reason !== AUTONOMOUS_OPS_SHADOW_REASON);
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
    ...(input.level ? { level: input.level } : {}),
    ...(input.shadow ? { shadow: true } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.deliveredVia ? { deliveredVia: input.deliveredVia } : {}),
    ...(input.actionId ? { actionId: input.actionId } : {}),
  });
}

type GateEscalationSource = Pick<
  AutonomousOpsGateResult,
  'escalations' | 'maxScore' | 'highRiskPathMatches' | 'actionClass'
>;

function listText(values: readonly string[], max = 3): string {
  const shown = values.slice(0, max).join(', ');
  return values.length > max ? `${shown} +${values.length - max}` : shown;
}

/**
 * The gate's escalation codes as sentences an operator can act on, instead of
 * the internal `reason` string (`autonomous ops score 5/6 for …`).
 */
export function describeGateEscalations(
  gate: Pick<AutonomousOpsGateResult, 'decision' | 'reason' | 'axes' | 'score'> &
    GateEscalationSource,
  locale: SupportedLocale = resolveLocale()
): string[] {
  const reasons: string[] = [];
  const maxedAxes = Object.entries(gate.axes)
    .filter(([, score]) => score >= 3)
    .map(([axis]) => axis);
  const neverAuto = /never-auto class: ([^;]+)/.exec(gate.reason)?.[1]?.trim();
  for (const escalation of gate.escalations) {
    switch (escalation) {
      case 'axis_max':
        reasons.push(t('decision:reason_axis_max', { axes: maxedAxes.join(', ') }, locale));
        break;
      case 'irreversible':
        reasons.push(t('decision:reason_irreversible', undefined, locale));
        break;
      case 'never_auto':
        reasons.push(
          t('decision:reason_never_auto', { classes: neverAuto || gate.actionClass || '' }, locale)
        );
        break;
      case 'high_risk_path':
        reasons.push(
          t('decision:reason_high_risk_path', { paths: listText(gate.highRiskPathMatches) }, locale)
        );
        break;
      case 'requested':
        reasons.push(t('decision:reason_requested', undefined, locale));
        break;
      case 'budget':
        reasons.push(t('decision:reason_budget', undefined, locale));
        break;
      default:
        reasons.push(escalation);
    }
  }
  if (reasons.length === 0 && gate.decision !== 'auto' && Number.isFinite(gate.score)) {
    reasons.push(
      t('decision:reason_score', { score: String(gate.score), max: String(gate.maxScore) }, locale)
    );
  }
  return reasons;
}
