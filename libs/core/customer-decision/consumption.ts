/**
 * Decision consumption at task boundaries (CD-09, plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-09 の実装設計"). Pure functions — callers read the stores and pass `now`.
 *
 *   - pin:       at a task's start, every effective decision of the case's open
 *                agendas (not closed, not withdrawn) — conservatively the whole
 *                case, since which decisions a task used is not known;
 *   - reconcile: at the task's end, the pinned values against the current
 *                resolution (value only, `checkDecisionFreshness`);
 *   - sweep:     after a customer response, the completed consumers that pinned
 *                a switched entry with a value that is no longer in force.
 *
 * A stale entry names the current decision it must move to (`ref`): the ledger
 * id, or `<agenda>/<entry>:<layer>` where that layer has no ledger record. A
 * rework WorkItem id is derived from the mission, the task and those refs, so
 * the completion check and the response sweep file one item for one switch.
 */
import { createHash } from 'node:crypto';
import { checkDecisionFreshness, resolveAgendaEffective } from './effective.js';
import {
  isConsumerId,
  type AgendaEntry,
  type ConsumedDecisionLock,
  type DecisionAgenda,
  type DecisionSwitch,
  type EffectiveDecision,
  type TaskDecisionProposal,
} from './model.js';
import type { ConsumedDecisionLockRecord } from './store.js';
import { canonicalJson, type DecisionRecord } from '../decision-ledger/model.js';
import type { TaskCustomerDecisionRequest } from '../surface/channel-surface-types.js';

const SAFE_TASK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;
const SAFE_MISSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/u;

function shortHash(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * The consumer id of one mission task: `mission-<MISSION_ID>.<task_id>`. A
 * segment that is not file-name safe is replaced by a short hash of itself.
 */
export function missionTaskConsumerId(missionId: string, taskId: string): string {
  const mission = missionId.toUpperCase();
  const missionSegment = SAFE_MISSION_SEGMENT.test(mission) ? mission : `M-${shortHash(mission)}`;
  const taskSegment = SAFE_TASK_SEGMENT.test(taskId) ? taskId : `t-${shortHash(taskId)}`;
  const consumer = `mission-${missionSegment}.${taskSegment}`;
  if (!isConsumerId(consumer)) {
    return `mission-M-${shortHash(mission)}.t-${shortHash(taskId)}`;
  }
  return consumer;
}

/** Agendas whose decisions are in play: everything but closed and withdrawn ones. */
export function openAgendas(agendas: readonly DecisionAgenda[]): DecisionAgenda[] {
  return agendas.filter((agenda) => agenda.status !== 'closed' && agenda.status !== 'withdrawn');
}

/** Pin every effective decision of the case's open agendas. */
export function buildConsumedDecisionLock(input: {
  caseId: string;
  consumer: string;
  agendas: readonly DecisionAgenda[];
  ledger: readonly DecisionRecord[];
  now: string;
}): ConsumedDecisionLock {
  const decisions: ConsumedDecisionLock['decisions'] = [];
  for (const agenda of openAgendas(input.agendas)) {
    for (const decision of resolveAgendaEffective(agenda, input.ledger, { now: input.now })) {
      decisions.push({
        agenda_id: agenda.agenda_id,
        entry_id: decision.entry_id,
        item: decision.item,
        key: decision.key,
        layer: decision.layer,
        ...(decision.decision_id ? { decision_id: decision.decision_id } : {}),
        ...(decision.value !== undefined ? { value: decision.value } : {}),
      });
    }
  }
  return {
    case_id: input.caseId,
    consumer: input.consumer,
    locked_at: input.now,
    decisions,
  };
}

/** The current decision a stale entry must move to, without its value. */
export function currentDecisionRef(
  agendaId: string | undefined,
  entryId: string | undefined,
  current: Pick<EffectiveDecision, 'decision_id' | 'layer' | 'value'> | undefined
): string {
  if (current?.decision_id) return current.decision_id;
  const base = `${agendaId ?? 'agenda'}/${entryId ?? 'entry'}:${current?.layer ?? 'gone'}`;
  // No ledger id: the value tells one draft edit from the next (A → B → C
  // files a second rework), as a short hash so no value is spelled out.
  return current && current.value !== undefined
    ? `${base}:${shortHash(canonicalJson(current.value), 12)}`
    : base;
}

export interface StaleConsumedDecision {
  agenda_id?: string;
  entry_id?: string;
  item: string;
  key: string;
  locked_decision_id?: string;
  current_decision_id?: string;
  ref: string;
}

export interface ConsumedDecisionReconciliation {
  checked: number;
  stale: StaleConsumedDecision[];
}

/**
 * Reconcile a lock against the current resolution of the agendas it pinned.
 * Each pinned entry is checked against its own agenda (whatever its status
 * now: an agenda closed after the pin still says what is in force); an
 * agenda that cannot be found any more makes its entries stale.
 */
export function reconcileConsumedDecisionLock(
  lock: ConsumedDecisionLock,
  agendas: readonly DecisionAgenda[],
  ledger: readonly DecisionRecord[],
  now: string
): ConsumedDecisionReconciliation {
  const byId = new Map(agendas.map((agenda) => [agenda.agenda_id, agenda]));
  const resolved = new Map<string, EffectiveDecision[]>();
  const currentFor = (agendaId: string | undefined): EffectiveDecision[] => {
    if (agendaId === undefined) {
      return openAgendas(agendas).flatMap((agenda) => effectiveOf(agenda));
    }
    const agenda = byId.get(agendaId);
    return agenda ? effectiveOf(agenda) : [];
  };
  const effectiveOf = (agenda: DecisionAgenda): EffectiveDecision[] => {
    let decisions = resolved.get(agenda.agenda_id);
    if (!decisions) {
      decisions = resolveAgendaEffective(agenda, ledger, { now });
      resolved.set(agenda.agenda_id, decisions);
    }
    return decisions;
  };
  const stale: StaleConsumedDecision[] = [];
  for (const locked of lock.decisions) {
    // A task proposal is a pin only once it is on an agenda and carries a
    // value (a requires_customer proposal is a hold, not a pin); it turns
    // stale only when a decided value in force differs from it.
    if (locked.layer === 'task_proposal' && (!locked.agenda_id || locked.value === undefined)) {
      continue;
    }
    const current = currentFor(locked.agenda_id).filter((decision) =>
      locked.entry_id !== undefined
        ? decision.entry_id === locked.entry_id
        : decision.item === locked.item && decision.key === locked.key
    );
    if (
      locked.layer === 'task_proposal' &&
      current.every((decision) => decision.layer === 'none' || decision.value === undefined)
    ) {
      continue;
    }
    const freshness = checkDecisionFreshness({ ...lock, decisions: [locked] }, current);
    if (freshness.fresh) continue;
    const inForce = freshness.stale[0]?.current;
    stale.push({
      ...(locked.agenda_id ? { agenda_id: locked.agenda_id } : {}),
      ...(locked.entry_id ? { entry_id: locked.entry_id } : {}),
      item: locked.item,
      key: locked.key,
      ...(locked.decision_id ? { locked_decision_id: locked.decision_id } : {}),
      ...(inForce?.decision_id ? { current_decision_id: inForce.decision_id } : {}),
      ref: currentDecisionRef(locked.agenda_id, locked.entry_id ?? inForce?.entry_id, inForce),
    });
  }
  return { checked: lock.decisions.length, stale };
}

/** Refs already covered by a rework WorkItem of this lock. */
export function reworkedRefs(lock: Pick<ConsumedDecisionLockRecord, 'rework'>): Set<string> {
  return new Set((lock.rework ?? []).flatMap((entry) => entry.refs));
}

/** Stale entries no rework WorkItem of this lock covers yet. */
export function unreworkedStale(
  lock: Pick<ConsumedDecisionLockRecord, 'rework'>,
  stale: readonly StaleConsumedDecision[]
): StaleConsumedDecision[] {
  const covered = reworkedRefs(lock);
  return stale.filter((entry) => !covered.has(entry.ref));
}

/**
 * The deterministic rework WorkItem id of one consumer and a set of current
 * decision refs (order-insensitive). Carries no item, key or value.
 */
export function decisionReworkWorkItemId(
  missionId: string,
  taskId: string,
  refs: readonly string[]
): string {
  const material = [missionId.toUpperCase(), taskId, ...[...new Set(refs)].sort()].join('\u0000');
  return `WI-CDR-${shortHash(material).toUpperCase()}`;
}

export interface ConsumerSweepFinding {
  lock: ConsumedDecisionLockRecord;
  checked: number;
  /** Stale entries on a switched agenda entry that no rework item covers yet. */
  stale: StaleConsumedDecision[];
}

/**
 * Response-time sweep: completed consumers that pinned a switched entry with a
 * value no longer in force. Running consumers are left to their own
 * completion check (a running task is never interrupted), and stale entries
 * already covered by a rework WorkItem are skipped, so the sweep is safe to
 * run again.
 */
export function findStaleConsumersForSwitches(input: {
  locks: readonly ConsumedDecisionLockRecord[];
  switches: readonly DecisionSwitch[];
  agendas: readonly DecisionAgenda[];
  ledger: readonly DecisionRecord[];
  now: string;
}): ConsumerSweepFinding[] {
  const switched = new Set(input.switches.map((item) => `${item.agenda_id}\u0000${item.entry_id}`));
  const switchedKeys = new Set(input.switches.map((item) => `${item.item}\u0000${item.key}`));
  const findings: ConsumerSweepFinding[] = [];
  for (const lock of input.locks) {
    if (lock.status !== 'completed') continue;
    const touches = lock.decisions.some((decision) =>
      decision.agenda_id !== undefined && decision.entry_id !== undefined
        ? switched.has(`${decision.agenda_id}\u0000${decision.entry_id}`)
        : switchedKeys.has(`${decision.item}\u0000${decision.key}`)
    );
    if (!touches) continue;
    const result = reconcileConsumedDecisionLock(lock, input.agendas, input.ledger, input.now);
    const stale = unreworkedStale(
      lock,
      result.stale.filter((entry) =>
        entry.agenda_id !== undefined && entry.entry_id !== undefined
          ? switched.has(`${entry.agenda_id}\u0000${entry.entry_id}`)
          : switchedKeys.has(`${entry.item}\u0000${entry.key}`)
      )
    );
    if (stale.length === 0) continue;
    findings.push({ lock, checked: result.checked, stale });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Task proposals (CD-09 "実装中の判断を顧客に回す")
// ---------------------------------------------------------------------------

type LockEntry = ConsumedDecisionLock['decisions'][number];
/** A `task_proposal` lock entry: always carries its proposal. */
export type TaskProposalLockEntry = LockEntry & { proposal: TaskDecisionProposal };

export const TASK_PROPOSAL_ID_PATTERN = /^tp-[a-f0-9]{16}$/u;

/** The proposal id of one consumer's question on an item × key (also its agenda entry id). */
export function taskProposalId(consumer: string, item: string, key: string): string {
  return `tp-${shortHash([consumer, item, key].join('\u0000'))}`;
}

export function isTaskProposalEntry(entry: LockEntry): entry is TaskProposalLockEntry {
  return entry.layer === 'task_proposal' && entry.proposal !== undefined;
}

/** The task proposals of a lock. */
export function taskProposalsOf(
  lock: Pick<ConsumedDecisionLock, 'decisions'>
): TaskProposalLockEntry[] {
  return lock.decisions.filter(isTaskProposalEntry);
}

/**
 * The open agenda entry that already asks this item × key and may carry the
 * question. A `requires_customer` question never links to an entry that is
 * not `requires_customer` (that entry would let our decision stand in for
 * the customer's); it stays pending for `customer-decision draft --from-tasks`.
 */
function openEntryFor(
  agendas: readonly DecisionAgenda[],
  item: string,
  key: string,
  requiresCustomer: boolean
): { agenda_id: string; entry_id: string } | undefined {
  for (const agenda of openAgendas(agendas)) {
    const entry = agenda.entries.find(
      (candidate) => candidate.item === item && candidate.key === key
    );
    if (!entry) continue;
    if (requiresCustomer && !entry.requires_customer) return undefined;
    return { agenda_id: agenda.agenda_id, entry_id: entry.entry_id };
  }
  return undefined;
}

/**
 * Add a task's customer-judgment questions to its lock. A question on an
 * item × key replaces the same task's earlier proposal for it unless that one
 * is already collected (it stays the one on the agenda). A question an open
 * agenda already asks is linked to that entry at once, so it is reconciled
 * against what the customer decides there and never collected twice.
 */
export function mergeTaskProposals(input: {
  lock: Pick<ConsumedDecisionLock, 'consumer' | 'decisions'>;
  requests: readonly TaskCustomerDecisionRequest[];
  agendas: readonly DecisionAgenda[];
  now: string;
}): { decisions: ConsumedDecisionLock['decisions']; proposal_ids: string[] } {
  const decisions = [...input.lock.decisions];
  const proposalIds: string[] = [];
  for (const request of input.requests) {
    const proposalId = taskProposalId(input.lock.consumer, request.item, request.key);
    const existing = decisions.findIndex(
      (entry) => isTaskProposalEntry(entry) && entry.proposal.proposal_id === proposalId
    );
    if (existing >= 0 && decisions[existing].agenda_id) {
      proposalIds.push(proposalId);
      continue;
    }
    // A later answer on the same item × key never lifts requires_customer.
    const requires =
      request.requires_customer ||
      (existing >= 0 && decisions[existing].proposal?.requires_customer === true);
    const linked = openEntryFor(input.agendas, request.item, request.key, requires);
    const proposal: TaskDecisionProposal = {
      proposal_id: proposalId,
      question: request.question,
      requires_customer: requires,
      ...(request.options?.length
        ? { options: request.options.map((option) => ({ ...option })) }
        : {}),
      ...(request.rationale ? { rationale: request.rationale } : {}),
      ...(request.topic ? { topic: request.topic } : {}),
      proposed_at: input.now,
      ...(linked ? { collected_at: input.now } : {}),
    };
    const entry: TaskProposalLockEntry = {
      ...(linked ?? {}),
      item: request.item,
      key: request.key,
      layer: 'task_proposal',
      ...(!requires && request.proposed_value !== undefined
        ? { value: request.proposed_value }
        : {}),
      proposal,
    };
    if (existing >= 0) decisions[existing] = entry;
    else decisions.push(entry);
    proposalIds.push(proposalId);
  }
  return { decisions, proposal_ids: [...new Set(proposalIds)] };
}

/** Proposals no agenda entry carries yet. */
export function pendingTaskProposals(
  lock: Pick<ConsumedDecisionLock, 'decisions'>
): TaskProposalLockEntry[] {
  return taskProposalsOf(lock).filter((entry) => !entry.agenda_id);
}

/**
 * The agenda entry a collected proposal becomes: a `choice` when it has
 * options, else an `approval`; our decision is the proposal, except on a
 * `requires_customer` question (the agenda schema forbids lower layers there,
 * so the customer approves the question itself).
 */
export function taskProposalAgendaEntry(entry: TaskProposalLockEntry): AgendaEntry {
  const { proposal } = entry;
  return {
    entry_id: proposal.proposal_id,
    item: entry.item,
    key: entry.key,
    kind: proposal.options?.length ? 'choice' : 'approval',
    question: proposal.question,
    ...(proposal.options?.length
      ? {
          options: proposal.options.map((option) => ({ value: option.value, label: option.label })),
        }
      : {}),
    ...(!proposal.requires_customer && entry.value !== undefined
      ? {
          our_decision: {
            value: entry.value,
            ...(proposal.rationale ? { rationale: proposal.rationale } : {}),
          },
        }
      : {}),
    requires_customer: proposal.requires_customer,
  };
}

export interface TaskProposalHold {
  proposal_id: string;
  collected: boolean;
  /** The confirmed customer decision on the proposal's agenda entry, once there is one. */
  resolved_decision_id?: string;
}

/**
 * The `requires_customer` proposals a lock holds on and whether each one has
 * a customer decision in force that the operator confirmed (a customer
 * decision on a `requires_customer` entry stays provisional until then).
 */
export function taskProposalHolds(
  lock: Pick<ConsumedDecisionLock, 'decisions'>,
  agendas: readonly DecisionAgenda[],
  ledger: readonly DecisionRecord[],
  now: string
): TaskProposalHold[] {
  const byId = new Map(agendas.map((agenda) => [agenda.agenda_id, agenda]));
  return taskProposalsOf(lock)
    .filter((entry) => entry.proposal.requires_customer)
    .map((entry) => {
      const hold: TaskProposalHold = {
        proposal_id: entry.proposal.proposal_id,
        collected: Boolean(entry.agenda_id),
      };
      if (entry.proposal.resolved) {
        return { ...hold, resolved_decision_id: entry.proposal.resolved.decision_id };
      }
      const agenda = entry.agenda_id ? byId.get(entry.agenda_id) : undefined;
      if (!agenda) return hold;
      const current = resolveAgendaEffective(agenda, ledger, { now }).find(
        (decision) => decision.entry_id === entry.entry_id
      );
      return current?.layer === 'customer' &&
        current.decision_id &&
        !current.awaiting_operator_confirmation
        ? { ...hold, resolved_decision_id: current.decision_id }
        : hold;
    });
}
