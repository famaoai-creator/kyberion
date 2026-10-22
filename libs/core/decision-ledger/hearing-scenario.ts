/**
 * Decision ledger ↔ hearing surface bridge (SD-02), pure.
 *
 * `ask` (what is still undecided, and for whom) becomes a hearing scenario:
 * one requirement per open decision, `requirement.id === decision.id`, so a
 * hearing answer lands on the decision it is about instead of in a brief's
 * free text. The reverse direction maps a hearing record's answered
 * requirements back to promotion requests the ledger applies through
 * `promote.ts`.
 *
 * The scenario shape is declared structurally here (the presence-studio
 * `HearingScenario` type must stay importable without `@agent/core`
 * depending on a surface module). `label_source: 'tenant'` marks labels that
 * are tenant-owned free text, so the surface renders `label_text` for them
 * and applies its vocabulary/i18n gate only to `label_source: 'vocabulary'`.
 */
import type { ActorRef } from '../actor.js';
import {
  DECISIONS_SCENARIO_PREFIX,
  DECISION_SAFE_SEGMENT_PATTERN,
  type DecisionBasis,
  type DecisionDecidedBy,
  type DecisionRecord,
  type DecisionLevel,
} from './model.js';

export interface LedgerHearingRequirement {
  id: string;
  label_key: string;
  label_source: 'vocabulary' | 'tenant';
  label_text?: string;
  aliases?: string[];
}

export interface LedgerHearingScenario {
  id: string;
  requirements: LedgerHearingRequirement[];
  /** Additive metadata the surface may show; never used for authorization. */
  ledger: { case_id: string; actor: string; open: number };
}

/** The placeholder vocabulary key every tenant-labelled requirement carries (resolves to a generic heading). */
export const LEDGER_TENANT_LABEL_KEY = 'front_desk:hearing_req_tenant_item';

export interface LedgerAskItem {
  decision: DecisionRecord;
  /** Who should answer: the customer actor for customer-value, else the product side. */
  ask: 'product' | 'customer';
}

/** Open decisions: active records that are not yet decided (proposed / observed / enacted / undecided level). */
export function askLedger(
  decisions: readonly DecisionRecord[],
  filter: { actor?: 'product' | 'customer' } = {}
): LedgerAskItem[] {
  return decisions
    .filter(
      (item) => item.status === 'active' && item.state !== 'decided' && item.state !== 'rejected'
    )
    .map<LedgerAskItem>((decision) => ({
      decision,
      ask: decision.level === 'customer-value' ? 'customer' : 'product',
    }))
    .filter((item) => !filter.actor || item.ask === filter.actor);
}

export function decisionsScenarioId(caseId: string, actor: 'product' | 'customer'): string {
  if (!DECISION_SAFE_SEGMENT_PATTERN.test(caseId) || /[^A-Za-z0-9_-]/u.test(caseId)) {
    throw new Error(
      '[DECISION_LEDGER_CASE_INVALID] case id must be a safe id (letters, digits, - _)'
    );
  }
  return `${DECISIONS_SCENARIO_PREFIX}-${caseId}-${actor}`;
}

export function parseDecisionsScenarioId(
  scenarioId: string
): { case_id: string; actor: 'product' | 'customer' } | undefined {
  const match = new RegExp(
    `^${DECISIONS_SCENARIO_PREFIX}-([A-Za-z0-9_-]+)-(product|customer)$`,
    'u'
  ).exec(scenarioId);
  return match ? { case_id: match[1], actor: match[2] as 'product' | 'customer' } : undefined;
}

export function buildHearingScenarioFromAsk(
  items: readonly LedgerAskItem[],
  options: { caseId: string; actor: 'product' | 'customer' }
): LedgerHearingScenario {
  const requirements = items
    .filter((item) => item.ask === options.actor)
    .map<LedgerHearingRequirement>(({ decision }) => ({
      id: decision.id,
      label_key: LEDGER_TENANT_LABEL_KEY,
      label_source: 'tenant',
      label_text: `${decision.item} · ${decision.key}`,
      aliases: [decision.key, decision.item.toLowerCase()],
    }));
  return {
    id: decisionsScenarioId(options.caseId, options.actor),
    requirements,
    ledger: { case_id: options.caseId, actor: options.actor, open: requirements.length },
  };
}

/** The subset of a hearing record this module needs (structural, surface-agnostic). */
export interface LedgerHearingAnswer {
  id: string;
  answer?: string;
  source_turn?: string;
}

export interface DecisionPromotionRequest {
  /** Existing open decision to supersede with the answered value. */
  promote: string;
  value: unknown;
  decided_by: DecisionDecidedBy;
  basis: DecisionBasis[];
  source_turn?: string;
  origin: 'hearing';
}

/** Parse an answer as JSON when it is one; otherwise keep the text. */
export function coerceAnswerValue(answer: string): unknown {
  const trimmed = answer.trim();
  if (/^(\{|\[|"|-?\d|true$|false$|null$)/u.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Answered requirements → promotion requests. Unanswered ones are skipped
 * (a hearing may decide part of its agenda). `level` is not changed here —
 * the answer is the value; the level stays what the ledger holds.
 */
export function hearingAnswersToPromotions(
  answers: readonly LedgerHearingAnswer[],
  options: { sessionId: string; decidedBy: DecisionDecidedBy; recordedBy?: ActorRef }
): DecisionPromotionRequest[] {
  return answers
    .filter((item) => typeof item.answer === 'string' && item.answer.trim().length > 0)
    .map<DecisionPromotionRequest>((item) => ({
      promote: item.id,
      value: coerceAnswerValue(item.answer as string),
      decided_by: options.decidedBy,
      basis: [
        {
          ref: `hearing:${options.sessionId}`,
          version: item.source_turn ? `turn:${item.source_turn}` : 'turn:unknown',
          note: options.recordedBy ? `recorded by ${options.recordedBy.id}` : undefined,
        },
      ],
      ...(item.source_turn ? { source_turn: item.source_turn } : {}),
      origin: 'hearing',
    }));
}

export function levelOfAsk(item: LedgerAskItem): DecisionLevel {
  return item.decision.level;
}
