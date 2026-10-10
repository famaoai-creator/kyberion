/**
 * Accountability charter — the pure decision core.
 *
 * Replaces per-action human approval (HITL) with a standing declaration by the
 * accountable human: who takes the fall, within what authority, and up to what
 * loss. Inside the charter an agent acts without asking; outside it the
 * action is denied and an amendment is proposed (nobody waits on a click).
 *
 * Invariants (see ACCOUNTABILITY_CHARTER_PLAN_2026-09-30.ja.md):
 *  1. Effective scope = accountable human's real authority ∩ envelope ∩ appetite.
 *     A charter never grants authority; it only declares how much of the
 *     existing authority is delegated. Exceeding authority is a validation error.
 *  2. Money / irreversible / contract classes need an authority basis that can
 *     carry them (owner or officer with evidence) — courage is not authority.
 *  3. Unavailable accountable human with no available deputy → safe mode
 *     (reversible, zero-money, no external effects only). Fail closed.
 *  4. Widening is never retroactive and only the accountable human can accept it.
 *
 * This module is pure (no I/O, no clock reads except via the `now` argument)
 * so it is deterministic and hermetically testable. Persistence lives in
 * `accountability-charter-registry.ts`.
 */

import { parseActorRef, type ActorRef } from '../actor.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type CharterScope = { kind: 'person' } | { kind: 'organization'; tenant_slug: string };

export type AuthorityBasisKind = 'owner' | 'officer' | 'delegated' | 'self';
export type CharterHolderRole = 'owner' | 'approver' | 'operator' | 'viewer';

export type ExternalEffectPolicy = 'forbid' | 'allow' | 'allow_with_review';
export type IrreversiblePolicy = 'forbid' | 'named_actions_only' | 'allow';
export type DataTier = 'public' | 'confidential' | 'personal';
export type ReputationalClass = 'A' | 'B' | 'C' | 'D';

export const EXTERNAL_EFFECT_CLASSES = [
  'send_message_external',
  'publish_public',
  'sign_contract',
  'payment',
  'credential_change',
] as const;
export type ExternalEffectClass = (typeof EXTERNAL_EFFECT_CLASSES)[number];

export interface MoneyLimits {
  currency: string;
  per_action: number;
  per_day: number;
  per_month: number;
}

export interface CharterEnvelope {
  money: MoneyLimits;
  data_tier: {
    read: string[]; // 'public' | 'confidential:<tenant>' | 'personal'
    write: string[];
  };
  external_effects: Partial<Record<ExternalEffectClass, ExternalEffectPolicy>>;
  irreversible: IrreversiblePolicy;
  /** Only consulted when irreversible === 'named_actions_only'. */
  irreversible_named_actions?: string[];
  /**
   * The accountable human's explicit, signed choice to let this charter stand
   * in for a decision-rights-matrix escalation (a decision type the matrix
   * routes to a human) when the action is inside the envelope. Default false:
   * the matrix always wins. Needs an owner/officer authority basis, because
   * the matrix is organizational governance, not a personal preference.
   */
  supersedes_decision_rights?: boolean;
  /**
   * Business decision types (charter-decision-vocabulary.json) the accountable
   * human delegates by name. A type that is not listed is forbidden: silence is
   * never a grant.
   */
  delegated_decisions?: Partial<Record<string, ExternalEffectPolicy>>;
}

export interface CharterAppetite {
  max_loss_per_incident: number;
  reputational_class_max: ReputationalClass;
  blast_radius_max: { recipients: number; systems: number };
  /** Human-readable "stop the world" conditions; matched by id against usage.tripwires_hit. */
  tripwires: string[];
}

export interface CharterAccountable {
  actor: string; // user:<member_id>
  authority_basis: { kind: AuthorityBasisKind; evidence_ref?: string };
  accepted_at: string;
  expires_at: string;
  statement_sha256: string;
  deputies: string[];
}

export interface Charter {
  charter_id: string;
  scope: CharterScope;
  accountable: CharterAccountable;
  envelope: CharterEnvelope;
  appetite: CharterAppetite;
}

/** Accounting the caller reads from the audit ledger; the core stays pure. */
export interface CharterUsage {
  spent_today: number;
  spent_this_month: number;
  tripwires_hit: string[];
}

export interface CharterAction {
  /** The executing actor. Agents must name the accountable human (or a deputy) in `on_behalf_of`. */
  actor: ActorRef;
  action_class: string;
  /**
   * Set for vocabulary decisions that need a per-type delegation; checked
   * against `envelope.delegated_decisions` in addition to every other limit.
   */
  decision_type?: string;
  amount?: number;
  currency?: string;
  data?: { tier: DataTier; tenant_slug?: string; mode: 'read' | 'write' };
  reversible: boolean;
  irreversible_action_name?: string;
  estimated_loss?: number;
  reputational_class?: ReputationalClass;
  blast_radius?: { recipients?: number; systems?: number };
  /** True when a cross-provider review of this action has already passed. */
  reviewed_by_other_provider?: boolean;
}

export interface CharterAvailability {
  accountable_available: boolean;
  available_deputies: string[];
}

export type CharterDecisionKind = 'allow' | 'allow_notify' | 'deny' | 'stop';

export interface AmendmentProposal {
  field: string;
  current: unknown;
  requested: unknown;
  reason: string;
}

export interface CharterDecision {
  decision: CharterDecisionKind;
  reasons: string[];
  /** Set on deny caused by envelope / appetite (never by missing authority). */
  amendment?: AmendmentProposal;
  /** Prefer a reversible alternative when the action was irreversible-but-allowed. */
  prefer_reversible?: boolean;
  /** What this action consumes, for the caller to append to the ledger. */
  consumption: { money: number; loss: number };
  /** Accountable party the decision is recorded against. */
  responsible: string;
  charter_id: string;
}

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

const EFFECT_RANK: Record<ExternalEffectPolicy, number> = {
  forbid: 0,
  allow_with_review: 1,
  allow: 2,
};
const IRREVERSIBLE_RANK: Record<IrreversiblePolicy, number> = {
  forbid: 0,
  named_actions_only: 1,
  allow: 2,
};
const REPUTATION_RANK: Record<ReputationalClass, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Effect classes that need a real authority basis, not just a decision-capable role. */
const BASIS_GATED_EFFECTS: ReadonlySet<string> = new Set(['sign_contract', 'payment']);

const NEAR_LIMIT_RATIO = 0.8;

function effectPolicy(env: CharterEnvelope, cls: string): ExternalEffectPolicy {
  return (
    (env.external_effects as Record<string, ExternalEffectPolicy | undefined>)[cls] ?? 'forbid'
  );
}

export function delegatedDecisionPolicy(
  env: CharterEnvelope,
  decisionType: string
): ExternalEffectPolicy {
  const table = env.delegated_decisions;
  if (!table || !Object.hasOwn(table, decisionType)) return 'forbid';
  const policy = table[decisionType];
  return isEffectPolicy(policy) ? policy : 'forbid';
}

function isEffectPolicy(value: unknown): value is ExternalEffectPolicy {
  return typeof value === 'string' && Object.hasOwn(EFFECT_RANK, value);
}

function dataScopeToken(tier: DataTier, tenant?: string): string {
  return tier === 'confidential' ? `confidential:${tenant ?? ''}` : tier;
}

// ---------------------------------------------------------------------------
// Validation — "authority cannot be exceeded"
// ---------------------------------------------------------------------------

export interface CharterValidationContext {
  /** Holder's membership role in the charter's tenant (person charters: 'owner'). */
  holder_role: CharterHolderRole;
  /**
   * Envelope of the charter this one is delegated from (authority_basis.kind
   * === 'delegated'). Required for delegated basis: the child must be a subset.
   */
  parent_envelope?: CharterEnvelope;
  /** Reference time for expiry sanity. */
  now: Date;
}

export function validateCharter(charter: Charter, ctx: CharterValidationContext): string[] {
  const violations: string[] = [];
  const { accountable, envelope, appetite } = charter;

  if (!parseActorRef({ kind: 'human', id: accountable.actor })) {
    violations.push(`accountable.actor '${accountable.actor}' is not a valid human actor id`);
  }
  for (const d of accountable.deputies) {
    if (!parseActorRef({ kind: 'human', id: d })) {
      violations.push(`deputy '${d}' is not a valid human actor id`);
    }
    if (d === accountable.actor) violations.push('a deputy must differ from the accountable human');
  }
  if (!/^[0-9a-f]{64}$/.test(accountable.statement_sha256)) {
    violations.push('accountable.statement_sha256 must be a sha256 hex digest');
  }
  const accepted = Date.parse(accountable.accepted_at);
  const expires = Date.parse(accountable.expires_at);
  if (Number.isNaN(accepted) || Number.isNaN(expires)) {
    violations.push('accepted_at / expires_at must be ISO timestamps');
  } else if (expires <= accepted) {
    violations.push('expires_at must be after accepted_at');
  }

  // Holder must be decision-capable at all.
  if (ctx.holder_role !== 'owner' && ctx.holder_role !== 'approver') {
    violations.push(
      `holder role '${ctx.holder_role}' cannot be accountable (needs owner or approver)`
    );
  }

  // Basis-gated effects need a basis that can carry them.
  const basisCanCarry =
    (accountable.authority_basis.kind === 'owner' ||
      accountable.authority_basis.kind === 'officer') &&
    Boolean(accountable.authority_basis.evidence_ref?.trim());
  for (const cls of BASIS_GATED_EFFECTS) {
    if (effectPolicy(envelope, cls) !== 'forbid' && !basisCanCarry) {
      violations.push(
        `external_effects.${cls} is permitted but authority_basis '${accountable.authority_basis.kind}' ` +
          'has no owner/officer basis with evidence_ref; authority cannot be exceeded'
      );
    }
  }
  if (envelope.supersedes_decision_rights === true && !basisCanCarry) {
    violations.push(
      'supersedes_decision_rights requires an owner/officer authority basis with evidence_ref; authority cannot be exceeded'
    );
  }
  for (const [type, policy] of Object.entries(envelope.delegated_decisions ?? {})) {
    if (!isEffectPolicy(policy)) {
      violations.push(
        `delegated_decisions.${type} must be forbid, allow_with_review or allow (got '${String(policy)}')`
      );
    }
  }
  if (envelope.money.per_action > 0 && effectPolicy(envelope, 'payment') === 'forbid') {
    violations.push('money.per_action > 0 requires external_effects.payment to be permitted');
  }
  if (
    envelope.irreversible === 'allow' &&
    !(
      accountable.authority_basis.kind === 'owner' || accountable.authority_basis.kind === 'officer'
    )
  ) {
    violations.push("irreversible: 'allow' requires an owner/officer authority basis");
  }

  // Internal coherence.
  const m = envelope.money;
  if (![m.per_action, m.per_day, m.per_month].every((n) => Number.isFinite(n) && n >= 0)) {
    violations.push('money limits must be non-negative finite numbers');
  } else if (m.per_action > m.per_day || m.per_day > m.per_month) {
    violations.push('money limits must satisfy per_action <= per_day <= per_month');
  }
  if (!(appetite.max_loss_per_incident >= 0) || !Number.isFinite(appetite.max_loss_per_incident)) {
    violations.push('appetite.max_loss_per_incident must be a non-negative finite number');
  }
  // Appetite may only tighten within the envelope: a single incident cannot
  // be allowed to lose more than the per-month money the envelope permits.
  if (appetite.max_loss_per_incident > m.per_month) {
    violations.push('appetite.max_loss_per_incident cannot exceed envelope.money.per_month');
  }

  // Delegation chain: a delegated charter is a subset of its parent.
  if (accountable.authority_basis.kind === 'delegated') {
    if (!ctx.parent_envelope) {
      violations.push("authority_basis 'delegated' requires the parent charter envelope");
    } else {
      violations.push(...envelopeExceeds(envelope, ctx.parent_envelope));
    }
  }
  return violations;
}

/** Fields where `child` is more permissive than `parent`. Empty = subset. */
export function envelopeExceeds(child: CharterEnvelope, parent: CharterEnvelope): string[] {
  const out: string[] = [];
  if (child.money.currency !== parent.money.currency) {
    out.push('money.currency differs from the parent envelope');
  }
  for (const key of ['per_action', 'per_day', 'per_month'] as const) {
    if (child.money[key] > parent.money[key]) {
      out.push(`money.${key} (${child.money[key]}) exceeds parent (${parent.money[key]})`);
    }
  }
  for (const mode of ['read', 'write'] as const) {
    for (const token of child.data_tier[mode]) {
      if (!parent.data_tier[mode].includes(token)) {
        out.push(`data_tier.${mode} '${token}' is not granted by the parent envelope`);
      }
    }
  }
  const classes = new Set<string>([
    ...Object.keys(child.external_effects),
    ...Object.keys(parent.external_effects),
  ]);
  for (const cls of classes) {
    if (EFFECT_RANK[effectPolicy(child, cls)] > EFFECT_RANK[effectPolicy(parent, cls)]) {
      out.push(`external_effects.${cls} is more permissive than the parent envelope`);
    }
  }
  if (IRREVERSIBLE_RANK[child.irreversible] > IRREVERSIBLE_RANK[parent.irreversible]) {
    out.push('irreversible is more permissive than the parent envelope');
  }
  if (child.supersedes_decision_rights === true && parent.supersedes_decision_rights !== true) {
    out.push('supersedes_decision_rights is not granted by the parent envelope');
  }
  const decisionTypes = new Set<string>([
    ...Object.keys(child.delegated_decisions ?? {}),
    ...Object.keys(parent.delegated_decisions ?? {}),
  ]);
  for (const type of decisionTypes) {
    if (
      EFFECT_RANK[delegatedDecisionPolicy(child, type)] >
      EFFECT_RANK[delegatedDecisionPolicy(parent, type)]
    ) {
      out.push(`delegated_decisions.${type} is more permissive than the parent envelope`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function isCharterActive(charter: Charter, now: Date): boolean {
  const t = now.getTime();
  return (
    Date.parse(charter.accountable.accepted_at) <= t &&
    t < Date.parse(charter.accountable.expires_at)
  );
}

export function evaluateAgainstCharter(input: {
  charter: Charter;
  action: CharterAction;
  usage: CharterUsage;
  availability: CharterAvailability;
  now: Date;
}): CharterDecision {
  const { charter, action, usage, availability, now } = input;
  const { envelope, appetite, accountable } = charter;
  const money = action.amount ?? 0;
  const loss = action.estimated_loss ?? 0;
  const base = {
    consumption: { money: 0, loss: 0 },
    responsible: accountable.actor,
    charter_id: charter.charter_id,
  };
  const deny = (reasons: string[], amendment?: AmendmentProposal): CharterDecision => ({
    ...base,
    decision: 'deny',
    reasons,
    ...(amendment ? { amendment } : {}),
  });

  // 0. Charter must be in force.
  if (!isCharterActive(charter, now)) return deny(['charter_not_active']);

  // 1. Who is acting, and on whose behalf?
  if (action.actor.kind === 'human') {
    // A human acting directly is not delegated work; the charter does not apply.
    return deny(['actor_is_human: charter governs delegated (agent/service) actions only']);
  }
  const behalf = action.actor.on_behalf_of;
  const holders = [accountable.actor, ...accountable.deputies];
  if (!behalf || !holders.includes(behalf)) {
    return deny([
      `actor_not_delegated: on_behalf_of '${behalf ?? ''}' is not the accountable human or a deputy`,
    ]);
  }

  // 2. Tripwire: stop the world.
  const hit = appetite.tripwires.filter((t) => usage.tripwires_hit.includes(t));
  if (hit.length > 0) {
    return { ...base, decision: 'stop', reasons: hit.map((t) => `tripwire:${t}`) };
  }

  // 3. Availability → safe mode (fail closed).
  const someoneAvailable =
    availability.accountable_available || availability.available_deputies.length > 0;
  if (!someoneAvailable) {
    const safe =
      action.reversible &&
      money === 0 &&
      loss === 0 &&
      !(EXTERNAL_EFFECT_CLASSES as readonly string[]).includes(action.action_class);
    if (!safe)
      return deny([
        'safe_mode: no accountable human or deputy available; only reversible zero-cost internal actions',
      ]);
  }

  // 4. Envelope.
  if (action.decision_type) {
    const policy = delegatedDecisionPolicy(envelope, action.decision_type);
    if (policy === 'forbid') {
      return deny([`delegated_decisions.${action.decision_type} not delegated`], {
        field: `envelope.delegated_decisions.${action.decision_type}`,
        current: 'forbid',
        requested: 'allow',
        reason: 'decision type not delegated by the accountable human',
      });
    }
    if (policy === 'allow_with_review' && !action.reviewed_by_other_provider) {
      return deny([
        `delegated_decisions.${action.decision_type} requires cross-provider review first`,
      ]);
    }
  }

  if (money > 0) {
    if (action.currency && action.currency !== envelope.money.currency) {
      return deny([`currency_mismatch: envelope is ${envelope.money.currency}`]);
    }
    if (money > envelope.money.per_action) {
      return deny(['money.per_action exceeded'], {
        field: 'envelope.money.per_action',
        current: envelope.money.per_action,
        requested: money,
        reason: 'single action above per-action limit',
      });
    }
    if (usage.spent_today + money > envelope.money.per_day) {
      return deny(['money.per_day exceeded'], {
        field: 'envelope.money.per_day',
        current: envelope.money.per_day,
        requested: usage.spent_today + money,
        reason: 'daily budget would be exceeded',
      });
    }
    if (usage.spent_this_month + money > envelope.money.per_month) {
      return deny(['money.per_month exceeded'], {
        field: 'envelope.money.per_month',
        current: envelope.money.per_month,
        requested: usage.spent_this_month + money,
        reason: 'monthly budget would be exceeded',
      });
    }
    if (effectPolicy(envelope, 'payment') === 'forbid') {
      return deny(['external_effects.payment forbidden']);
    }
  }

  if ((EXTERNAL_EFFECT_CLASSES as readonly string[]).includes(action.action_class)) {
    const policy = effectPolicy(envelope, action.action_class);
    if (policy === 'forbid') {
      return deny([`external_effects.${action.action_class} forbidden`], {
        field: `envelope.external_effects.${action.action_class}`,
        current: 'forbid',
        requested: 'allow',
        reason: 'action class not delegated by the accountable human',
      });
    }
    if (policy === 'allow_with_review' && !action.reviewed_by_other_provider) {
      return deny([`external_effects.${action.action_class} requires cross-provider review first`]);
    }
  }

  if (action.data) {
    const token = dataScopeToken(action.data.tier, action.data.tenant_slug);
    if (!envelope.data_tier[action.data.mode].includes(token)) {
      return deny([`data_tier.${action.data.mode} '${token}' not delegated`], {
        field: `envelope.data_tier.${action.data.mode}`,
        current: envelope.data_tier[action.data.mode],
        requested: token,
        reason: 'data scope not delegated by the accountable human',
      });
    }
  }

  let preferReversible = false;
  if (!action.reversible) {
    if (envelope.irreversible === 'forbid') {
      return deny(['irreversible actions forbidden'], {
        field: 'envelope.irreversible',
        current: 'forbid',
        requested: 'named_actions_only',
        reason: 'no reversible path was offered',
      });
    }
    if (
      envelope.irreversible === 'named_actions_only' &&
      !(
        action.irreversible_action_name &&
        envelope.irreversible_named_actions?.includes(action.irreversible_action_name)
      )
    ) {
      return deny(['irreversible action is not on the named list'], {
        field: 'envelope.irreversible_named_actions',
        current: envelope.irreversible_named_actions ?? [],
        requested: action.irreversible_action_name ?? action.action_class,
        reason: 'irreversible action not pre-named by the accountable human',
      });
    }
    preferReversible = true;
  }

  // 5. Appetite.
  if (loss > appetite.max_loss_per_incident) {
    return deny(['appetite.max_loss_per_incident exceeded'], {
      field: 'appetite.max_loss_per_incident',
      current: appetite.max_loss_per_incident,
      requested: loss,
      reason: 'estimated loss above declared tolerance',
    });
  }
  if (
    action.reputational_class &&
    REPUTATION_RANK[action.reputational_class] > REPUTATION_RANK[appetite.reputational_class_max]
  ) {
    return deny(['appetite.reputational_class_max exceeded'], {
      field: 'appetite.reputational_class_max',
      current: appetite.reputational_class_max,
      requested: action.reputational_class,
      reason: 'reputational exposure above declared tolerance',
    });
  }
  const br = action.blast_radius;
  if (
    (br?.recipients ?? 0) > appetite.blast_radius_max.recipients ||
    (br?.systems ?? 0) > appetite.blast_radius_max.systems
  ) {
    return deny(['appetite.blast_radius_max exceeded'], {
      field: 'appetite.blast_radius_max',
      current: appetite.blast_radius_max,
      requested: br,
      reason: 'blast radius above declared tolerance',
    });
  }

  // 6. Inside the charter. Notify when budgets run close to the edge.
  const nearLimit =
    money > 0 &&
    ((usage.spent_today + money) / envelope.money.per_day >= NEAR_LIMIT_RATIO ||
      (usage.spent_this_month + money) / envelope.money.per_month >= NEAR_LIMIT_RATIO);
  const reasons = ['within_charter'];
  if (nearLimit) reasons.push('budget_near_limit');
  return {
    ...base,
    decision: nearLimit ? 'allow_notify' : 'allow',
    reasons,
    consumption: { money, loss },
    ...(preferReversible ? { prefer_reversible: true } : {}),
  };
}
