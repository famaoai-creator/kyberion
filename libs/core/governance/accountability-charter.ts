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

/** Deterministic, boundary-derived information facts used for autonomous egress. */
export type InformationCategory =
  'routine_business' | 'personal_data' | 'sensitive_business' | 'unknown';
export const INFORMATION_CATEGORIES: readonly InformationCategory[] = [
  'routine_business',
  'personal_data',
  'sensitive_business',
  'unknown',
];

/**
 * Who receives the facts. `known_counterparty` is a named outside party the
 * organization already has a relationship with (a prospect, partner or an
 * individual contact), which is narrower than `public` and is not a customer
 * or a supplier under an approved procurement relationship.
 */
export type RecipientClass =
  'bound_customer' | 'known_counterparty' | 'approved_vendor' | 'public' | 'unknown';
export const RECIPIENT_CLASSES: readonly RecipientClass[] = [
  'bound_customer',
  'known_counterparty',
  'approved_vendor',
  'public',
  'unknown',
];
export interface InformationFlowFacts {
  purpose: string;
  recipient_class?: RecipientClass;
  processor_id?: string;
  categories: InformationCategory[];
  attachment_count: number;
}
export interface InformationFlowEnvelope {
  purposes: string[];
  recipient_classes: RecipientClass[];
  categories: InformationCategory[];
  max_attachments: number;
  /** When present, constrains inference/API processors independently of recipients. */
  processor_ids?: string[];
  processing_purposes?: string[];
  processing_categories?: InformationCategory[];
}

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
  /** Optional, explicit information-flow scope. Omission grants no info-flow delegation. */
  information_flow?: InformationFlowEnvelope;
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
  /** Facts must be constructed at a trusted boundary, never from model output. */
  information_flow?: InformationFlowFacts;
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

/** Shared information-flow rule used by both action and reasoning egress gates. */
export function evaluateInformationFlow(
  envelope: CharterEnvelope,
  facts: InformationFlowFacts
): string[] {
  const grant = envelope.information_flow;
  if (!grant) return ['information_flow not delegated'];
  if (
    !facts.purpose?.trim() ||
    !Array.isArray(facts.categories) ||
    facts.categories.length === 0 ||
    !Number.isInteger(facts.attachment_count) ||
    facts.attachment_count < 0
  )
    return ['information_flow facts are incomplete or invalid'];
  if (facts.processor_id && facts.recipient_class)
    return ['information_flow facts cannot mix a processor and an external recipient'];
  if (facts.processor_id) {
    if (!grant.processor_ids?.includes(facts.processor_id))
      return [`information_flow processor '${facts.processor_id}' not delegated`];
    if (!grant.processing_purposes?.includes(facts.purpose))
      return [`information_flow processing purpose '${facts.purpose}' not delegated`];
    const excluded = facts.categories.filter(
      (category) => !grant.processing_categories?.includes(category)
    );
    if (excluded.length)
      return [`information_flow processing categories not delegated: ${excluded.join(',')}`];
  } else {
    if (!facts.recipient_class || !grant.purposes.includes(facts.purpose))
      return [`information_flow purpose '${facts.purpose}' not delegated`];
    if (!grant.recipient_classes.includes(facts.recipient_class))
      return [`information_flow recipient '${facts.recipient_class}' not delegated`];
    if (facts.attachment_count > grant.max_attachments)
      return ['information_flow attachment limit exceeded'];
    const excluded = facts.categories.filter((category) => !grant.categories.includes(category));
    if (excluded.length)
      return [`information_flow categories not delegated: ${excluded.join(',')}`];
  }
  return [];
}

/** Actions that leave the organization with recipient facts (not inference processors). */
export function isInformationBoundActionClass(actionClass: string): boolean {
  return actionClass === 'send_message_external' || actionClass === 'publish_public';
}

export type InformationFlowFactsParse =
  { ok: true; facts: InformationFlowFacts } | { ok: false; error: string };

const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/;
const PROCESSOR_PATTERN = /^[a-z0-9][a-z0-9 ._:-]{0,127}$/i;

/**
 * Validate caller-supplied facts at the trusted boundary (a validated pipeline
 * step, never model output). Invalid facts are an input error: the caller must
 * not silently fall back to "no facts", because that would turn a malformed
 * declaration into a different (ambiguous) decision.
 */
export function parseInformationFlowFacts(value: unknown): InformationFlowFactsParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'information_flow must be an object' };
  }
  const raw = value as Record<string, unknown>;
  const purpose = typeof raw.purpose === 'string' ? raw.purpose.trim() : '';
  if (!PURPOSE_PATTERN.test(purpose)) {
    return { ok: false, error: 'information_flow.purpose must be a lowercase id' };
  }
  const recipientClass = raw.recipient_class;
  if (
    recipientClass !== undefined &&
    !RECIPIENT_CLASSES.includes(recipientClass as RecipientClass)
  ) {
    return { ok: false, error: 'information_flow.recipient_class is not a known recipient class' };
  }
  const processorId = raw.processor_id;
  if (
    processorId !== undefined &&
    (typeof processorId !== 'string' || !PROCESSOR_PATTERN.test(processorId.trim()))
  ) {
    return { ok: false, error: 'information_flow.processor_id is invalid' };
  }
  if (recipientClass === undefined && processorId === undefined) {
    return {
      ok: false,
      error: 'information_flow needs recipient_class (external action) or processor_id (inference)',
    };
  }
  const categories = raw.categories;
  if (
    !Array.isArray(categories) ||
    categories.length === 0 ||
    categories.some((c) => !INFORMATION_CATEGORIES.includes(c as InformationCategory))
  ) {
    return {
      ok: false,
      error: 'information_flow.categories must be a non-empty list of known categories',
    };
  }
  const attachmentCount = raw.attachment_count ?? 0;
  if (
    typeof attachmentCount !== 'number' ||
    !Number.isInteger(attachmentCount) ||
    attachmentCount < 0 ||
    attachmentCount > 100
  ) {
    return {
      ok: false,
      error: 'information_flow.attachment_count must be an integer between 0 and 100',
    };
  }
  return {
    ok: true,
    facts: {
      purpose,
      ...(recipientClass !== undefined
        ? { recipient_class: recipientClass as RecipientClass }
        : {}),
      ...(processorId !== undefined ? { processor_id: processorId.trim() } : {}),
      categories: [...new Set(categories as InformationCategory[])],
      attachment_count: attachmentCount,
    },
  };
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
  const flow = envelope.information_flow;
  if (flow) {
    const validStringList = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0);
    if (!validStringList(flow.purposes))
      violations.push('information_flow.purposes must be non-empty strings');
    if (
      !Array.isArray(flow.recipient_classes) ||
      flow.recipient_classes.some((v) => !RECIPIENT_CLASSES.includes(v))
    )
      violations.push('information_flow.recipient_classes contains an invalid value');
    if (
      !Array.isArray(flow.categories) ||
      flow.categories.some((v) => !INFORMATION_CATEGORIES.includes(v))
    )
      violations.push('information_flow.categories contains an invalid value');
    if (!Number.isInteger(flow.max_attachments) || flow.max_attachments < 0)
      violations.push('information_flow.max_attachments must be a non-negative integer');
    if (flow.processor_ids !== undefined && !validStringList(flow.processor_ids))
      violations.push('information_flow.processor_ids must be non-empty strings');
    if (flow.processing_purposes !== undefined && !validStringList(flow.processing_purposes))
      violations.push('information_flow.processing_purposes must be non-empty strings');
    if (
      flow.processing_categories !== undefined &&
      (!Array.isArray(flow.processing_categories) ||
        flow.processing_categories.some((v) => !INFORMATION_CATEGORIES.includes(v)))
    )
      violations.push('information_flow.processing_categories contains an invalid value');
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
  if (child.information_flow) {
    const p = parent.information_flow;
    if (!p) out.push('information_flow is not granted by the parent envelope');
    else {
      for (const key of ['purposes', 'recipient_classes', 'categories'] as const) {
        for (const value of child.information_flow[key]) {
          if (!(p[key] as string[]).includes(value))
            out.push(`information_flow.${key} '${value}' is not granted by the parent envelope`);
        }
      }
      if (child.information_flow.max_attachments > p.max_attachments)
        out.push('information_flow.max_attachments exceeds parent envelope');
      for (const key of [
        'processor_ids',
        'processing_purposes',
        'processing_categories',
      ] as const) {
        if (p[key] !== undefined && child.information_flow[key] === undefined)
          out.push(`information_flow.${key} omits a parent restriction`);
        for (const value of child.information_flow[key] ?? []) {
          if (!(p[key] ?? []).includes(value as never))
            out.push(`information_flow.${key} '${value}' is not granted by the parent envelope`);
        }
      }
    }
  } else if (parent.information_flow) {
    out.push('information_flow is omitted but restricted by the parent envelope');
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

  const informationBoundAction =
    action.action_class === 'send_message_external' || action.action_class === 'publish_public';
  if (envelope.information_flow) {
    if (action.information_flow) {
      if (informationBoundAction && action.information_flow.processor_id)
        return deny(['external recipient actions require recipient facts, not processor facts']);
      const violations = evaluateInformationFlow(envelope, action.information_flow);
      if (violations.length) return deny(violations);
    } else if (informationBoundAction) {
      return deny(['information_flow facts are required for external recipient actions']);
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
