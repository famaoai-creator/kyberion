/**
 * CD-08: plan a customer's response to one approved agenda revision
 * (docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md).
 *
 * Pure: no I/O, no clock — the facade (`scripts/customer_decision.ts respond`)
 * passes the agenda, the ledger, the verified invite, the registered customer
 * actors, a pre-generated receipt id and `now`, then performs the writes in
 * order (ledger append all-or-nothing → receipt → switches → reflection).
 *
 * Rules:
 *   - the response binds to the approved revision: the submitted content hash
 *     must equal the approval hash, which must equal the agenda's current content;
 *   - every answer is validated against its entry (`option` ∈ the approved
 *     options by canonical JSON, `keep` only where something is in force,
 *     `approve` / `request_changes` only for `approval` entries, `free_text`
 *     for `hearing` entries and as a comment-only answer elsewhere);
 *   - a contributor's answers are recorded in the receipt and never reach the ledger;
 *   - a decider's answer becomes a `customer-value` / `decided` ledger record that
 *     supersedes the active record — unless the customer already decided the same
 *     value (idempotent double submit), or the override window closed and the value
 *     differs (a change request: recorded in the receipt, no ledger write).
 *
 * Refusal reasons are stable, customer-safe codes; nothing here carries prose.
 */
import { humanActor } from '../actor.js';
import {
  canonicalJson,
  type DecisionCustomerActor,
  type DecisionDecidedBy,
  type DecisionRecord,
} from '../decision-ledger/model.js';
import type { DecisionAppendInput } from '../decision-ledger/ledger.js';
import { canActorDecideLevel } from '../decision-ledger/promote.js';
import type { DecisionAuthorityPolicy } from '../decision-ledger/policy.js';
import { agendaContentHash } from './hash.js';
import { checkLayerPrecedence, resolveAgendaEffective } from './effective.js';
import type { CustomerDecisionInvite } from './invite.js';
import {
  AGENDA_ENTRY_ID_PATTERN,
  type AgendaEntry,
  type DecisionAgenda,
  type DecisionReceipt,
  type EffectiveDecision,
  type ReceiptAnswerChoice,
  type ReceiptAnswerOutcome,
} from './model.js';

export interface RespondAnswer {
  entry_id: string;
  choice: ReceiptAnswerChoice;
  value?: unknown;
  comment?: string;
}

export type RespondAnswerError =
  | 'unknown_entry'
  | 'duplicate_entry'
  | 'choice_invalid'
  | 'choice_not_allowed'
  | 'option_not_offered'
  | 'keep_not_available'
  | 'text_required'
  | 'comment_too_long';

export type RespondRefusal =
  /** The invite does not belong to this agenda (never surfaced as more than `invalid_link`). */
  | 'invalid_link'
  /** The agenda was edited after approval and not re-approved yet. */
  | 'updating'
  /** The agenda is closed or withdrawn. */
  | 'closed'
  /** The screen answered an older revision — reload. */
  | 'stale_version'
  | 'invalid_answers'
  /** The invitee's customer actor is not registered or not entitled to decide. */
  | 'not_entitled';

export type RespondOutcome =
  /** A ledger record will be appended. */
  | 'decided'
  /** The customer already decided this value — nothing to write. */
  | 'unchanged'
  /** Override window closed and the value differs — a change request, no ledger write. */
  | 'change_request'
  /** Contributor answer or comment-only answer — receipt only. */
  | 'recorded';

export interface RespondAnswerPlan {
  answer: RespondAnswer;
  outcome: RespondOutcome;
  /** The value the answer stands for (`keep` resolves to the current effective value). */
  value?: unknown;
  /** Index into {@link RespondPlan.appends} when `outcome === 'decided'`. */
  append_index?: number;
}

export interface RespondPlan {
  receipt_id: string;
  content_hash: string;
  answers: RespondAnswerPlan[];
  appends: DecisionAppendInput[];
  /** Effective decisions before any write (for switch detection). */
  before: EffectiveDecision[];
  change_requests: Array<{ entry_id: string; value?: unknown; comment?: string }>;
}

export type RespondPlanResult =
  | { ok: true; plan: RespondPlan }
  | {
      ok: false;
      reason: RespondRefusal;
      errors?: Array<{ entry_id: string; error: RespondAnswerError }>;
    };

export interface PlanCustomerResponseInput {
  agenda: DecisionAgenda;
  ledger: readonly DecisionRecord[];
  invite: CustomerDecisionInvite;
  /** Raw, untrusted request fields. */
  content_hash: unknown;
  answers: unknown;
  customerActors: readonly DecisionCustomerActor[];
  receiptId: string;
  now: string;
  policy?: DecisionAuthorityPolicy;
}

const MAX_COMMENT = 10000;
const MAX_ANSWERS = 200;
const CHOICES: readonly ReceiptAnswerChoice[] = [
  'option',
  'keep',
  'free_text',
  'approve',
  'request_changes',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/** The human actor id the ledger records for an invitee: `user:<invite_id>` (member-id grammar). */
export function inviteeActorId(invite: Pick<CustomerDecisionInvite, 'invite_id'>): string {
  return humanActor(invite.invite_id).id;
}

/** The `decided_by` of a customer decision taken through an invite link. */
export function inviteeDecidedBy(
  invite: Pick<CustomerDecisionInvite, 'invite_id' | 'participant'>,
  receiptId: string
): DecisionDecidedBy {
  return {
    kind: 'human',
    id: inviteeActorId(invite),
    display_name: invite.participant.name,
    on_behalf_of: { actor_id: invite.participant.actor_id, evidence: receiptId },
  };
}

/**
 * Is the agenda in a state a customer may see and answer? `updating` when the
 * content no longer matches the approval (edited after sending, not re-approved).
 */
export function agendaAnswerState(
  agenda: DecisionAgenda
): { ok: true; content_hash: string } | { ok: false; reason: 'updating' | 'closed' } {
  if (agenda.status === 'closed' || agenda.status === 'withdrawn') {
    return { ok: false, reason: 'closed' };
  }
  if (agenda.status !== 'approved' && agenda.status !== 'sent') {
    return { ok: false, reason: 'updating' };
  }
  const hash = agendaContentHash(agenda);
  if (!agenda.approval || agenda.approval.content_hash !== hash) {
    return { ok: false, reason: 'updating' };
  }
  return { ok: true, content_hash: hash };
}

function parseAnswers(
  raw: unknown
): { ok: true; answers: RespondAnswer[] } | { ok: false; entry_id: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANSWERS) {
    return { ok: false, entry_id: '' };
  }
  const answers: RespondAnswer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return { ok: false, entry_id: '' };
    const record = item as Record<string, unknown>;
    const entryId = record.entry_id;
    if (typeof entryId !== 'string' || !AGENDA_ENTRY_ID_PATTERN.test(entryId)) {
      return { ok: false, entry_id: '' };
    }
    const answer: RespondAnswer = {
      entry_id: entryId,
      choice: record.choice as ReceiptAnswerChoice,
    };
    if ('value' in record && record.value !== undefined) answer.value = record.value;
    if (record.comment !== undefined) {
      if (typeof record.comment !== 'string') return { ok: false, entry_id: entryId };
      const comment = record.comment.trim();
      if (comment) answer.comment = comment;
    }
    answers.push(answer);
  }
  return { ok: true, answers };
}

function optionOffered(entry: AgendaEntry, value: unknown): boolean {
  const options = entry.options ?? [];
  if (options.some((option) => sameValue(option.value, value))) return true;
  // A ranking answers with an ordered subset of the offered option values.
  if (entry.kind === 'ranking' && Array.isArray(value) && value.length > 0) {
    const seen = new Set<string>();
    for (const item of value) {
      const key = canonicalJson(item);
      if (seen.has(key)) return false;
      seen.add(key);
      if (!options.some((option) => sameValue(option.value, item))) return false;
    }
    return true;
  }
  return false;
}

/**
 * Validate one answer against its entry. Returns the value the answer stands
 * for, `null` for a comment-only answer, or the error.
 */
function validateAnswer(
  entry: AgendaEntry,
  answer: RespondAnswer,
  current: EffectiveDecision
): { ok: true; value: unknown; commentOnly: boolean } | { ok: false; error: RespondAnswerError } {
  if (!CHOICES.includes(answer.choice)) return { ok: false, error: 'choice_invalid' };
  if (answer.comment && answer.comment.length > MAX_COMMENT) {
    return { ok: false, error: 'comment_too_long' };
  }
  switch (answer.choice) {
    case 'option':
      if (answer.value === undefined || !optionOffered(entry, answer.value)) {
        return { ok: false, error: 'option_not_offered' };
      }
      return { ok: true, value: answer.value, commentOnly: false };
    case 'keep':
      if (
        current.status === 'awaiting_customer' ||
        current.status === 'undecided' ||
        current.value === undefined
      ) {
        return { ok: false, error: 'keep_not_available' };
      }
      return { ok: true, value: current.value, commentOnly: false };
    case 'approve':
      if (entry.kind !== 'approval') return { ok: false, error: 'choice_not_allowed' };
      return {
        ok: true,
        value:
          entry.our_decision?.value !== undefined ? entry.our_decision.value : { approved: true },
        commentOnly: false,
      };
    case 'request_changes':
      if (entry.kind !== 'approval') return { ok: false, error: 'choice_not_allowed' };
      if (!answer.comment) return { ok: false, error: 'text_required' };
      return { ok: true, value: { approved: false, comment: answer.comment }, commentOnly: false };
    case 'free_text': {
      const text =
        typeof answer.value === 'string' && answer.value.trim()
          ? answer.value.trim()
          : answer.comment;
      if (!text) return { ok: false, error: 'text_required' };
      if (text.length > MAX_COMMENT) return { ok: false, error: 'comment_too_long' };
      // Outside `hearing`, free text is a comment for the operator, never a decision.
      if (entry.kind !== 'hearing') return { ok: true, value: undefined, commentOnly: true };
      return { ok: true, value: text, commentOnly: false };
    }
    default:
      return { ok: false, error: 'choice_invalid' };
  }
}

/** Plan a response. Never throws for untrusted input — refusals come back as codes. */
export function planCustomerResponse(input: PlanCustomerResponseInput): RespondPlanResult {
  const { agenda, invite, now } = input;
  if (
    invite.agenda_id !== agenda.agenda_id ||
    invite.case_id !== agenda.case_id ||
    invite.tenant_slug !== agenda.tenant_slug
  ) {
    return { ok: false, reason: 'invalid_link' };
  }
  const state = agendaAnswerState(agenda);
  if (state.ok === false) return { ok: false, reason: state.reason };
  if (input.content_hash !== state.content_hash) return { ok: false, reason: 'stale_version' };

  const parsed = parseAnswers(input.answers);
  if (parsed.ok === false) {
    return {
      ok: false,
      reason: 'invalid_answers',
      errors: [{ entry_id: parsed.entry_id, error: 'choice_invalid' }],
    };
  }

  const before = resolveAgendaEffective(agenda, input.ledger, { now });
  const entries = new Map(agenda.entries.map((entry) => [entry.entry_id, entry]));
  const effective = new Map(before.map((decision) => [decision.entry_id, decision]));
  const errors: Array<{ entry_id: string; error: RespondAnswerError }> = [];
  const seen = new Set<string>();
  const validated: Array<{
    answer: RespondAnswer;
    entry: AgendaEntry;
    current: EffectiveDecision;
    value: unknown;
    commentOnly: boolean;
  }> = [];
  for (const answer of parsed.answers) {
    const entry = entries.get(answer.entry_id);
    if (!entry) {
      errors.push({ entry_id: answer.entry_id, error: 'unknown_entry' });
      continue;
    }
    if (seen.has(answer.entry_id)) {
      errors.push({ entry_id: answer.entry_id, error: 'duplicate_entry' });
      continue;
    }
    seen.add(answer.entry_id);
    const current = effective.get(entry.entry_id) as EffectiveDecision;
    const result = validateAnswer(entry, answer, current);
    if (result.ok === false) {
      errors.push({ entry_id: answer.entry_id, error: result.error });
      continue;
    }
    validated.push({
      answer,
      entry,
      current,
      value: result.value,
      commentOnly: result.commentOnly,
    });
  }
  if (errors.length) return { ok: false, reason: 'invalid_answers', errors };

  const decider = invite.participant.role === 'decider';
  const decidedBy = inviteeDecidedBy(invite, input.receiptId);
  if (decider) {
    const entitled = canActorDecideLevel(
      'customer-value',
      decidedBy,
      input.customerActors,
      input.policy
    );
    if (entitled.ok === false) return { ok: false, reason: 'not_entitled' };
  }

  const plan: RespondPlan = {
    receipt_id: input.receiptId,
    content_hash: state.content_hash,
    answers: [],
    appends: [],
    before,
    change_requests: [],
  };
  for (const { answer, entry, current, value, commentOnly } of validated) {
    const receiptAnswer: RespondAnswer = {
      entry_id: answer.entry_id,
      choice: answer.choice,
      ...(value !== undefined ? { value } : {}),
      ...(answer.comment ? { comment: answer.comment } : {}),
    };
    if (!decider || commentOnly) {
      plan.answers.push({
        answer: receiptAnswer,
        outcome: 'recorded',
        ...(value !== undefined ? { value } : {}),
      });
      continue;
    }
    if (current.layer === 'customer' && sameValue(current.value, value)) {
      plan.answers.push({ answer: receiptAnswer, outcome: 'unchanged', value });
      continue;
    }
    const precedence = checkLayerPrecedence(current, 'customer');
    // Confirming the value already in force changes nothing, so it is not an
    // override even after the window closed; a different value is a change request.
    if (precedence.ok === false && !sameValue(current.value, value)) {
      plan.answers.push({ answer: receiptAnswer, outcome: 'change_request', value });
      plan.change_requests.push({
        entry_id: entry.entry_id,
        value,
        ...(answer.comment ? { comment: answer.comment } : {}),
      });
      continue;
    }
    const active = [...input.ledger]
      .reverse()
      .find(
        (record) =>
          record.status === 'active' && record.item === entry.item && record.key === entry.key
      );
    const record: DecisionAppendInput = {
      item: entry.item,
      key: entry.key,
      level: 'customer-value',
      state: 'decided',
      value,
      basis: [{ ref: `agenda:${agenda.agenda_id}`, version: state.content_hash }],
      decided_by: decidedBy,
      decided_at: now,
      origin: 'facade',
      ...(active ? { supersedes: active.id } : {}),
    };
    plan.answers.push({
      answer: receiptAnswer,
      outcome: 'decided',
      value,
      append_index: plan.appends.length,
    });
    plan.appends.push(record);
  }
  return { ok: true, plan };
}

function receiptOutcome(outcome: RespondOutcome): ReceiptAnswerOutcome {
  return outcome === 'recorded' ? 'opinion' : outcome;
}

/** A receipt answer without its outcome (what the customer sent, for duplicate checks). */
function sentAnswer(answer: DecisionReceipt['answers'][number]): RespondAnswer {
  const { outcome: _outcome, ...sent } = answer;
  void _outcome;
  return sent;
}

/** The immutable receipt for a planned response, once the ledger assigned the decision ids. */
export function buildResponseReceipt(
  plan: RespondPlan,
  agenda: DecisionAgenda,
  invite: CustomerDecisionInvite,
  appendedIds: readonly string[],
  now: string
): DecisionReceipt {
  return {
    version: '1.0.0',
    receipt_id: plan.receipt_id,
    tenant_slug: agenda.tenant_slug,
    case_id: agenda.case_id,
    agenda_id: agenda.agenda_id,
    agenda_revision: agenda.revision,
    content_hash: plan.content_hash,
    invite_id: invite.invite_id,
    participant: {
      name: invite.participant.name,
      role: invite.participant.role,
      actor_id: invite.participant.actor_id,
    },
    answers: plan.answers.map((item) => ({
      ...item.answer,
      outcome: receiptOutcome(item.outcome),
    })),
    identity_assurance: 'invite_link',
    submitted_at: now,
    decision_ids: [...appendedIds],
  };
}

/**
 * Double submit: the same invite already answered this revision with the same
 * answers, and nothing would be written now. The facade returns that receipt.
 */
export function findDuplicateReceipt(
  plan: RespondPlan,
  invite: Pick<CustomerDecisionInvite, 'invite_id'>,
  previous: readonly DecisionReceipt[]
): DecisionReceipt | undefined {
  if (plan.appends.length > 0) return undefined;
  const answers = canonicalJson(plan.answers.map((item) => item.answer));
  return [...previous]
    .reverse()
    .find(
      (receipt) =>
        receipt.invite_id === invite.invite_id &&
        receipt.content_hash === plan.content_hash &&
        canonicalJson(receipt.answers.map(sentAnswer)) === answers
    );
}

/**
 * Change requests still open: a decider's latest answer per entry whose
 * recorded outcome is `change_request` and whose value is still not what the
 * work follows now. A later `decided` / `unchanged` answer closes it, and an
 * answer the customer later re-decided, or an operator applied, drops out.
 * Receipts written before outcomes were recorded fall back to inferring a
 * candidate from any decider answer with a value.
 */
export function openChangeRequests(
  agenda: DecisionAgenda,
  receipts: readonly DecisionReceipt[],
  effective: readonly EffectiveDecision[]
): Array<{ receipt_id: string; entry_id: string; value?: unknown; comment?: string; at: string }> {
  const current = new Map(effective.map((decision) => [decision.entry_id, decision]));
  const kinds = new Map(agenda.entries.map((entry) => [entry.entry_id, entry.kind]));
  const latest = new Map<
    string,
    { receipt_id: string; entry_id: string; value?: unknown; comment?: string; at: string }
  >();
  for (const receipt of receipts) {
    if (receipt.participant.role !== 'decider') continue;
    for (const answer of receipt.answers) {
      if (answer.outcome === 'opinion') continue;
      if (answer.outcome === 'decided' || answer.outcome === 'unchanged') {
        latest.delete(answer.entry_id);
        continue;
      }
      if (answer.value === undefined) continue;
      if (
        answer.outcome === undefined &&
        answer.choice === 'free_text' &&
        kinds.get(answer.entry_id) !== 'hearing'
      )
        continue;
      latest.set(answer.entry_id, {
        receipt_id: receipt.receipt_id,
        entry_id: answer.entry_id,
        value: answer.value,
        ...(answer.comment ? { comment: answer.comment } : {}),
        at: receipt.submitted_at,
      });
    }
  }
  return [...latest.values()].filter(
    (item) => !sameValue(current.get(item.entry_id)?.value, item.value)
  );
}
