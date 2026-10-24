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
  type ConsumedDecisionLock,
  type DecisionAgenda,
  type DecisionSwitch,
  type EffectiveDecision,
} from './model.js';
import type { ConsumedDecisionLockRecord } from './store.js';
import type { DecisionRecord } from '../decision-ledger/model.js';

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
  current: Pick<EffectiveDecision, 'decision_id' | 'layer'> | undefined
): string {
  if (current?.decision_id) return current.decision_id;
  return `${agendaId ?? 'agenda'}/${entryId ?? 'entry'}:${current?.layer ?? 'gone'}`;
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
    const current = currentFor(locked.agenda_id).filter((decision) =>
      locked.entry_id !== undefined
        ? decision.entry_id === locked.entry_id
        : decision.item === locked.item && decision.key === locked.key
    );
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
