/**
 * Decision ledger promotion machine (SD-00 §2.2): `proposed → decided` is the
 * only transition a human performs, and it is bounded by *level × actor*.
 *
 * Which roles may decide which level, whether an axis needs enumerated
 * options, and whether a customer value needs a registered actor plus
 * evidence are **policy**, not code: they come from
 * `knowledge/product/governance/decision-authority-policy.json`
 * ({@link DecisionAuthorityPolicy}); the in-code default mirrors it so this
 * module stays pure and callable without I/O.
 *
 * Pure: no I/O, no clock — callers pass `now`. The refusal reasons are
 * stable identifiers (not prose) so the facade and the surface can map them
 * to vocabulary.
 */
import { assertHumanActor } from '../actor.js';
import {
  CUSTOMER_ACTOR_ID_PATTERN,
  decidedByActorRef,
  type DecisionCustomerActor,
  type DecisionDecidedBy,
  type DecisionLevel,
  type DecisionRecord,
} from './model.js';
import { DEFAULT_DECISION_AUTHORITY_POLICY, type DecisionAuthorityPolicy } from './policy.js';

export type DecisionPromotionRefusal =
  | 'actor_not_human'
  | 'role_cannot_decide'
  | 'level_undecided'
  | 'axis_without_options'
  | 'customer_actor_required'
  | 'customer_actor_unknown'
  | 'customer_actor_not_entitled'
  | 'customer_approval_required'
  | 'basis_required';

export interface DecisionPromotionInput {
  decision: DecisionRecord;
  decidedBy: DecisionDecidedBy;
  now: string;
  /** Customer actors the tenant registered for this case's customer (SD-04). */
  customerActors?: readonly DecisionCustomerActor[];
  /** Authority policy; defaults to the shipped catalog's in-code mirror. */
  policy?: DecisionAuthorityPolicy;
}

export type DecisionPromotionResult =
  | { outcome: 'decided'; decision: DecisionRecord }
  | {
      outcome: 'proposed';
      decision: DecisionRecord;
      reason: DecisionPromotionRefusal;
      ask?: string;
    };

/** Which refusals are "come back with more" (the record is kept as proposed) versus hard errors. */
export function promotionRefusalKeepsProposal(reason: DecisionPromotionRefusal): boolean {
  return (
    reason === 'customer_approval_required' ||
    reason === 'axis_without_options' ||
    reason === 'level_undecided' ||
    reason === 'customer_actor_required'
  );
}

export function canActorDecideLevel(
  level: DecisionLevel,
  decidedBy: DecisionDecidedBy,
  customerActors: readonly DecisionCustomerActor[] = [],
  policy: DecisionAuthorityPolicy = DEFAULT_DECISION_AUTHORITY_POLICY
): { ok: true } | { ok: false; reason: DecisionPromotionRefusal; ask?: string } {
  if (decidedBy.kind !== 'human') return { ok: false, reason: 'actor_not_human' };
  if (level === 'undecided') return { ok: false, reason: 'level_undecided' };
  const rule = policy.levels[level];
  if (!rule.customer_actor_required) {
    return decidedBy.role && rule.deciding_roles.includes(decidedBy.role)
      ? { ok: true }
      : { ok: false, reason: 'role_cannot_decide' };
  }
  const behalf = decidedBy.on_behalf_of;
  if (!behalf || !behalf.actor_id) return { ok: false, reason: 'customer_actor_required' };
  if (!CUSTOMER_ACTOR_ID_PATTERN.test(behalf.actor_id)) {
    return { ok: false, reason: 'customer_actor_unknown' };
  }
  const actor = customerActors.find((item) => item.id === behalf.actor_id);
  if (!actor) return { ok: false, reason: 'customer_actor_unknown' };
  if (!actor.decides.includes(level)) {
    return { ok: false, reason: 'customer_actor_not_entitled' };
  }
  if (rule.customer_evidence_required && !(behalf.evidence && behalf.evidence.trim())) {
    return {
      ok: false,
      reason: 'customer_approval_required',
      ask: behalf.confirm_target || actor.confirm_target || actor.id,
    };
  }
  return { ok: true };
}

/**
 * Attempt the promotion. Never throws for an authority refusal — the caller
 * gets the record back as `proposed` with a stable `pending_reason` — but
 * does throw for a non-human actor, because recording a machine as a
 * decider is a contract violation, not a pending state.
 */
export function promoteDecision(input: DecisionPromotionInput): DecisionPromotionResult {
  assertHumanActor(decidedByActorRef(input.decidedBy), 'decision-ledger.decide');
  const { decision, decidedBy, now } = input;
  const policy = input.policy ?? DEFAULT_DECISION_AUTHORITY_POLICY;
  const rule = policy.levels[decision.level];
  const base: DecisionRecord = { ...decision, decided_by: decidedBy };
  const refuse = (reason: DecisionPromotionRefusal, ask?: string): DecisionPromotionResult => ({
    outcome: 'proposed',
    reason,
    ...(ask ? { ask } : {}),
    decision: { ...base, state: 'proposed', pending_reason: reason },
  });
  if (rule?.requires_options && (!decision.options || decision.options.length === 0)) {
    return refuse('axis_without_options');
  }
  if (policy.basis_required_for_decided && (!decision.basis || decision.basis.length === 0)) {
    return refuse('basis_required');
  }
  const authority = canActorDecideLevel(decision.level, decidedBy, input.customerActors, policy);
  if (authority.ok === false) return refuse(authority.reason, authority.ask);
  const { pending_reason: _drop, ...rest } = base;
  void _drop;
  return { outcome: 'decided', decision: { ...rest, state: 'decided', decided_at: now } };
}
