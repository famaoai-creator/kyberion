/**
 * CD-09: customer decisions at mission task boundaries (plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-09 の実装設計").
 *
 *   - start:    pin every effective decision of the mission's decision case
 *               (`consumers/<consumer>.json`, confidential, narrow consumer store role);
 *   - complete: reconcile the pin against the current decisions; a stale
 *               result still completes, and a rework WorkItem is filed;
 *   - respond:  after a customer response, completed consumers that pinned a
 *               switched entry are reconciled the same way;
 *   - propose:  a task result's customer-judgment questions are kept on the
 *               task's own lock (layer `task_proposal`) for the operator to
 *               collect (`customer-decision draft --from-tasks`); a
 *               `requires_customer` one holds the task until the operator
 *               confirms the customer's decision (released by the sweep).
 *
 * A running task is never interrupted. The case is found from the mission's
 * `tenant_slug` and `relationships.project.project_id`, else a deal whose
 * `mission_ids` holds the mission; a mission with no existing decision case
 * is left alone. Every entry point is best-effort: a failure logs a
 * diagnostic warning and never breaks the task or the customer's response.
 *
 * Tier boundary: decision items, keys and values stay in the confidential
 * lock file. The results returned here (for public mission evidence) and the
 * rework WorkItem (the work-coordination store is not tenant-partitioned)
 * carry counts, the consumer id, the case id and WorkItem ids only.
 */
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import { listDeals, type DealRecord } from '../deal-store.js';
import {
  CUSTOMER_DECISION_CONSUMER_STORE_ROLE,
  customerDecisionConsumerCapability,
  type CustomerDecisionConsumerAccess,
} from '../foundation/customer-decision-consumer-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { pathResolver } from '../path-resolver.js';
import { isValidCaseId, ledgerDir, readLedger } from '../decision-ledger/ledger.js';
import {
  buildConsumedDecisionLock,
  decisionReworkWorkItemId,
  findStaleConsumersForSwitches,
  isTaskProposalEntry,
  mergeTaskProposals,
  missionTaskConsumerId,
  reconcileConsumedDecisionLock,
  taskProposalHolds,
  taskProposalId,
  unreworkedStale,
  type StaleConsumedDecision,
} from '../customer-decision/consumption.js';
import type { TaskCustomerDecisionRequest } from '../surface/channel-surface-types.js';
import type { DecisionAgenda, DecisionSwitch } from '../customer-decision/model.js';
import {
  listAgendaIds,
  listConsumedDecisionLockIds,
  readAgenda,
  readConsumedDecisionLock,
  readSwitches,
  withCustomerDecisionCaseLock,
  writeConsumedDecisionLock,
  type ConsumedDecisionLockRecord,
  type CustomerDecisionLocation,
} from '../customer-decision/store.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { nowIso } from '../foundation/time.js';
import { safeExistsSync } from '../secure-io.js';
import { t } from '../t.js';
import { WorkCoordinationError } from '../workforce/work-coordination-error.js';
import {
  createWorkItemIfAbsent,
  getWorkItem,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import { loadState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

export interface MissionDecisionCase {
  tenantSlug: string;
  caseId: string;
  source: 'project' | 'deal';
  location: CustomerDecisionLocation;
}

export interface MissionDecisionLockOptions {
  now?: string;
  /** The case to use instead of resolving it from mission state (tests, callers that know it). */
  decisionCase?: MissionDecisionCase | null;
  loadMissionState?: (missionId: string) => MissionState | null;
  listTenantDeals?: (tenantSlug: string) => DealRecord[];
  caseExists?: (decisionCase: MissionDecisionCase) => boolean;
  /** Work coordination root (tests). */
  workItemRootDir?: string;
}

export interface PinTaskDecisionsResult {
  consumer: string;
  pinned_count: number;
  /** false when an existing lock was kept (a re-recorded start). */
  pinned: boolean;
}

export interface TaskDecisionReconciliation {
  consumer?: string;
  checked: number;
  stale_count: number;
  rework_work_item_ids: string[];
}

const NOTHING_CHECKED: TaskDecisionReconciliation = {
  checked: 0,
  stale_count: 0,
  rework_work_item_ids: [],
};

function diagnosticCode(error: unknown): string {
  if (error instanceof WorkCoordinationError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /\[([A-Z0-9_]+)\]/u.exec(message)?.[1] ?? 'error';
}

function warn(what: string, error: unknown, evidence: string): void {
  logger.warn(
    `${what} — ${diagnosticCode(error)} | the task is not blocked; re-run record-evidence (completion) or the next customer-decision respond (sweep) to retry | ${evidence}`
  );
}

/**
 * Run `fn` as the narrow consumer store role bound to the case's tenant,
 * inside the exact deny-only capability for `access` (case-relative paths).
 */
function asConsumerStore<T>(
  tenantSlug: string,
  location: CustomerDecisionLocation,
  access: CustomerDecisionConsumerAccess,
  fn: () => T
): T {
  const caseDir = pathResolver.toRepoRelative(ledgerDir(location));
  return runInResourceAccessScope(
    customerDecisionConsumerCapability(tenantSlug, caseDir, access),
    () => withExecutionContext(CUSTOMER_DECISION_CONSUMER_STORE_ROLE, fn, undefined, tenantSlug)
  );
}

/** Reads exactly `knowledge/personal/tenants/<tenant>.json` (shared core role). */
const TENANT_REGISTRY_READER_ROLE = 'workspace_tenant_registry_reader';

const consumerFile = (consumer: string) => `consumers/${consumer}.json`;

interface CaseSnapshot {
  agendas: DecisionAgenda[];
  ledger: ReturnType<typeof readLedger>;
  switches: ReturnType<typeof readSwitches>;
  locks: ConsumedDecisionLockRecord[];
}

/**
 * Read what a boundary needs from the case: list `agendas/` and `consumers/`,
 * then read the ledger, switches, every agenda and the wanted consumer locks
 * (`all`, or the named ones that exist), each under its exact capability.
 */
function readCase(
  decisionCase: MissionDecisionCase,
  consumers: 'all' | readonly string[],
  onInvalidLock: (consumer: string, error: unknown) => void = () => undefined
): CaseSnapshot {
  const { tenantSlug, location } = decisionCase;
  const listed = asConsumerStore(tenantSlug, location, { read: ['agendas', 'consumers'] }, () => ({
    agendaIds: listAgendaIds(location),
    consumerIds: listConsumedDecisionLockIds(location),
  }));
  const wanted =
    consumers === 'all'
      ? listed.consumerIds
      : listed.consumerIds.filter((id) => consumers.includes(id));
  const read = [
    'decisions.jsonl',
    'switches.jsonl',
    ...listed.agendaIds.map((id) => `agendas/${id}.json`),
    ...wanted.map(consumerFile),
  ];
  return asConsumerStore(tenantSlug, location, { read }, () => {
    const locks: ConsumedDecisionLockRecord[] = [];
    for (const id of wanted) {
      try {
        const lock = readConsumedDecisionLock(location, id);
        if (lock) locks.push(lock);
      } catch (error) {
        onInvalidLock(id, error);
      }
    }
    return {
      agendas: listed.agendaIds
        .map((id) => readAgenda(location, id))
        .filter((agenda): agenda is NonNullable<typeof agenda> => Boolean(agenda)),
      ledger: readLedger(location),
      switches: readSwitches(location),
      locks,
    };
  });
}

function writeLock(decisionCase: MissionDecisionCase, lock: ConsumedDecisionLockRecord): void {
  asConsumerStore(
    decisionCase.tenantSlug,
    decisionCase.location,
    { read: [], write: consumerFile(lock.consumer) },
    () => writeConsumedDecisionLock(decisionCase.location, lock)
  );
}

function defaultCaseExists(decisionCase: MissionDecisionCase): boolean {
  return asConsumerStore(decisionCase.tenantSlug, decisionCase.location, { read: [] }, () =>
    safeExistsSync(ledgerDir(decisionCase.location))
  );
}

function caseFor(
  tenantSlug: string,
  caseId: string,
  source: MissionDecisionCase['source']
): MissionDecisionCase | null {
  if (!isValidCaseId(caseId)) return null;
  return { tenantSlug, caseId, source, location: { tenantSlug, caseId } };
}

/**
 * The decision case of a mission: its project's case, else the case of a deal
 * that lists the mission. Null when the mission has no tenant or no such case
 * directory exists. Throws only on store failures (callers log and go on).
 */
export function resolveMissionDecisionCase(
  missionId: string,
  options: MissionDecisionLockOptions = {}
): MissionDecisionCase | null {
  if (options.decisionCase !== undefined) return options.decisionCase;
  const state = (options.loadMissionState ?? loadState)(missionId.toUpperCase());
  const tenantSlug = state?.tenant_slug;
  if (!state || !tenantSlug || !isValidTenantSlug(tenantSlug)) return null;
  const exists = options.caseExists ?? defaultCaseExists;
  const projectId = state.relationships?.project?.project_id;
  if (projectId) {
    const candidate = caseFor(tenantSlug, projectId, 'project');
    if (candidate && exists(candidate)) return candidate;
  }
  const upper = missionId.toUpperCase();
  const deals = (options.listTenantDeals ?? listDeals)(tenantSlug).filter((deal) =>
    deal.mission_ids.some((id) => id.toUpperCase() === upper)
  );
  for (const deal of deals) {
    const candidate = caseFor(tenantSlug, deal.deal_id, 'deal');
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Task start: pin the case's effective decisions for this task.
 *   - `start` (worker dispatch): keeps a lock still in progress (a redispatch
 *     of the same run), re-pins a completed one (a new run);
 *   - `if_absent` (record-task): keeps any existing lock, so a record-task
 *     written after completion never moves the pin.
 * Null when the mission has no decision case, or on failure (logged).
 */
export function pinTaskDecisions(
  input: { missionId: string; taskId: string; mode?: 'start' | 'if_absent' },
  options: MissionDecisionLockOptions = {}
): PinTaskDecisionsResult | null {
  const consumer = missionTaskConsumerId(input.missionId, input.taskId);
  try {
    const decisionCase = resolveMissionDecisionCase(input.missionId, options);
    if (!decisionCase) return null;
    const now = options.now ?? nowIso();
    const mode = input.mode ?? 'start';
    return withCustomerDecisionCaseLock(decisionCase.location, () => {
      const { agendas, ledger, locks } = readCase(decisionCase, [consumer]);
      const existing = locks[0];
      // A held task (waiting for the customer) re-runs on the current
      // decisions once it is resumed: a start re-pins it like a new run.
      if (
        existing &&
        (mode === 'if_absent' || (existing.status === 'in_progress' && !existing.hold))
      ) {
        return { consumer, pinned_count: pinCount(existing), pinned: false };
      }
      const lock = buildConsumedDecisionLock({
        caseId: decisionCase.caseId,
        consumer,
        agendas,
        ledger,
        now,
      });
      writeLock(decisionCase, {
        version: '1.0.0',
        ...lock,
        ...('dir' in decisionCase.location ? {} : { tenant_slug: decisionCase.tenantSlug }),
        mission_id: input.missionId.toUpperCase(),
        task_id: input.taskId,
        status: 'in_progress',
      });
      return { consumer, pinned_count: lock.decisions.length, pinned: true };
    });
  } catch (error) {
    warn('customer decision pin skipped', error, consumer);
    return null;
  }
}

/** Pinned decisions of a lock (task proposals are not pins of the case). */
function pinCount(lock: Pick<ConsumedDecisionLockRecord, 'decisions'>): number {
  return lock.decisions.filter((entry) => entry.layer !== 'task_proposal').length;
}

export interface TaskDecisionProposalResult {
  /** false: the mission has no decision case and nothing was recorded. */
  case_found: boolean;
  consumer: string;
  case_id?: string;
  /** Proposals now on the task's lock from this result. */
  recorded: number;
  proposal_ids: string[];
  /** `requires_customer` proposals without a confirmed customer decision: the task waits on them. */
  hold_proposal_ids: string[];
  /** Recording failed (logged): the caller still holds on every `requires_customer` question. */
  failed?: boolean;
}

/**
 * Task result (CD-09 "実装中の判断を顧客に回す"): record the task's
 * customer-judgment questions on its own consumer lock (layer
 * `task_proposal`), for the operator to collect into an agenda
 * (`customer-decision draft --from-tasks`). A `requires_customer` question
 * without a confirmed customer decision puts a hold on the lock; the caller
 * blocks the task. The worker never gets agenda-write authority: it writes
 * its own lock under the narrow consumer store role.
 *
 * No decision case: nothing is recorded (a diagnostic warning); the caller
 * treats `requires_customer` questions as ordinary clarification needs.
 * Never throws. The result carries ids and counts only.
 */
export function recordTaskDecisionProposals(
  input: {
    missionId: string;
    taskId: string;
    requests: readonly TaskCustomerDecisionRequest[];
    /** The task's WorkItem, recorded on a hold so its release can note the decision. */
    workItemId?: string;
  },
  options: MissionDecisionLockOptions = {}
): TaskDecisionProposalResult {
  const consumer = missionTaskConsumerId(input.missionId, input.taskId);
  const requestedHolds = [
    ...new Set(
      input.requests
        .filter((request) => request.requires_customer)
        .map((request) => taskProposalId(consumer, request.item, request.key))
    ),
  ];
  const nothing = { consumer, recorded: 0, proposal_ids: [], hold_proposal_ids: [] };
  if (input.requests.length === 0) return { case_found: false, ...nothing };
  try {
    const decisionCase = resolveMissionDecisionCase(input.missionId, options);
    if (!decisionCase) {
      logger.warn(
        `customer decision proposals not recorded — the mission has no decision case | requires_customer questions become clarification needs, the others go on with the proposal; create the case to collect them | ${consumer} count=${input.requests.length}`
      );
      return { case_found: false, ...nothing };
    }
    const now = options.now ?? nowIso();
    return withCustomerDecisionCaseLock(decisionCase.location, () => {
      const { agendas, ledger, locks } = readCase(decisionCase, [consumer]);
      const base: ConsumedDecisionLockRecord = locks[0] ?? {
        version: '1.0.0',
        ...buildConsumedDecisionLock({
          caseId: decisionCase.caseId,
          consumer,
          agendas,
          ledger,
          now,
        }),
        ...('dir' in decisionCase.location ? {} : { tenant_slug: decisionCase.tenantSlug }),
        mission_id: input.missionId.toUpperCase(),
        task_id: input.taskId,
        status: 'in_progress',
      };
      const merged = mergeTaskProposals({ lock: base, requests: input.requests, agendas, now });
      const holds = taskProposalHolds({ decisions: merged.decisions }, agendas, ledger, now).filter(
        (hold) => requestedHolds.includes(hold.proposal_id)
      );
      const resolved = new Map(
        holds.flatMap((hold) =>
          hold.resolved_decision_id ? [[hold.proposal_id, hold.resolved_decision_id] as const] : []
        )
      );
      const pending = holds
        .filter((hold) => !hold.resolved_decision_id)
        .map((hold) => hold.proposal_id);
      const { hold: _previousHold, ...rest } = base;
      void _previousHold;
      writeLock(decisionCase, {
        ...rest,
        decisions: merged.decisions.map((entry) => {
          const decisionId = isTaskProposalEntry(entry)
            ? resolved.get(entry.proposal.proposal_id)
            : undefined;
          return decisionId && isTaskProposalEntry(entry) && !entry.proposal.resolved
            ? {
                ...entry,
                proposal: { ...entry.proposal, resolved: { decision_id: decisionId, at: now } },
              }
            : entry;
        }),
        ...(pending.length > 0
          ? { hold: { ...(input.workItemId ? { work_item_id: input.workItemId } : {}), at: now } }
          : {}),
      });
      return {
        case_found: true,
        consumer,
        case_id: decisionCase.caseId,
        recorded: merged.proposal_ids.length,
        proposal_ids: merged.proposal_ids,
        hold_proposal_ids: pending,
      };
    });
  } catch (error) {
    logger.warn(
      `customer decision proposals not recorded — ${diagnosticCode(error)} | the task waits on its requires_customer questions and goes on with the others; resume the mission to retry | ${consumer}`
    );
    return { case_found: true, ...nothing, hold_proposal_ids: requestedHolds, failed: true };
  }
}

/**
 * Note on a held task's WorkItem that its hold is resolved (ids only: the
 * work-coordination store is not tenant-partitioned). The WorkItem stays
 * `blocked`; `mission resume` re-runs the task, which re-pins its lock.
 */
function noteHoldResolved(
  decisionCase: MissionDecisionCase,
  lock: ConsumedDecisionLockRecord,
  decisionIds: readonly string[],
  now: string,
  options: Pick<MissionDecisionLockOptions, 'workItemRootDir'>
): void {
  const itemId = lock.hold?.work_item_id;
  if (!itemId) return;
  const rootDir = options.workItemRootDir;
  const item = getWorkItem(itemId, rootDir ? { rootDir } : {});
  if (!item) return;
  updateWorkItem({
    itemId,
    expectedVersion: item.version,
    ...(rootDir ? { rootDir } : {}),
    metadata: {
      ...(item.metadata ?? {}),
      customer_decision_hold: {
        status: 'resolved',
        case_id: decisionCase.caseId,
        consumer: lock.consumer,
        decision_ids: [...decisionIds].sort(),
        resolved_at: now,
        next: `pnpm mission resume ${lock.mission_id}`,
      },
    },
  });
}

/**
 * Held tasks whose `requires_customer` proposals all have a confirmed
 * customer decision now: mark the proposals and the hold resolved on the
 * lock and note it on the WorkItem. Holding the case lock.
 */
function releaseResolvedHolds(
  decisionCase: MissionDecisionCase,
  snapshot: Pick<CaseSnapshot, 'agendas' | 'ledger' | 'locks'>,
  now: string,
  options: MissionDecisionLockOptions
): string[] {
  const released: string[] = [];
  for (const lock of snapshot.locks) {
    if (!lock.hold || lock.hold.resolved_at) continue;
    try {
      const holds = taskProposalHolds(lock, snapshot.agendas, snapshot.ledger, now);
      const resolved = new Map(
        holds.flatMap((hold) =>
          hold.resolved_decision_id ? [[hold.proposal_id, hold.resolved_decision_id] as const] : []
        )
      );
      if (resolved.size === 0) continue;
      const complete = holds.every((hold) => hold.resolved_decision_id);
      // WorkItem first: if the lock write then fails, the next sweep notes it again.
      if (complete) {
        noteHoldResolved(decisionCase, lock, [...new Set(resolved.values())], now, options);
      }
      writeLock(decisionCase, {
        ...lock,
        decisions: lock.decisions.map((entry) => {
          const decisionId = isTaskProposalEntry(entry)
            ? resolved.get(entry.proposal.proposal_id)
            : undefined;
          return decisionId && isTaskProposalEntry(entry) && !entry.proposal.resolved
            ? {
                ...entry,
                proposal: { ...entry.proposal, resolved: { decision_id: decisionId, at: now } },
              }
            : entry;
        }),
        hold: { ...lock.hold, ...(complete ? { resolved_at: now } : {}) },
      });
      if (complete) released.push(lock.consumer);
    } catch (error) {
      warn('customer decision hold release skipped', error, lock.consumer);
    }
  }
  return released;
}

/**
 * File (or find) the rework WorkItem of one consumer for a set of current
 * decision refs. Runs under the caller's identity (the work-coordination
 * store takes its own role); the id is deterministic, so a second call from
 * the other boundary finds the same item.
 */
export function fileDecisionReworkWorkItem(
  input: {
    tenantSlug: string;
    caseId: string;
    lock: Pick<ConsumedDecisionLockRecord, 'consumer' | 'mission_id' | 'task_id'>;
    refs: readonly string[];
  },
  options: Pick<MissionDecisionLockOptions, 'workItemRootDir'> = {}
): string {
  const refs = [...new Set(input.refs)].sort();
  const itemId = decisionReworkWorkItemId(input.lock.mission_id, input.lock.task_id, refs);
  const rootDir = options.workItemRootDir;
  if (getWorkItem(itemId, rootDir ? { rootDir } : {})) return itemId;
  const params = {
    missionId: input.lock.mission_id,
    taskId: input.lock.task_id,
    caseId: input.caseId,
    consumer: input.lock.consumer,
    count: refs.length,
  };
  const create = () =>
    createWorkItemIfAbsent({
      ...(rootDir ? { rootDir } : {}),
      itemId,
      title: t('customer_decision:rework_work_item_title', params),
      description: t('customer_decision:rework_work_item_description', params),
      status: 'backlog',
      priority: 'normal',
      source: 'local',
      sourceRef: `customer-decision:${input.caseId}:${input.lock.consumer}`,
      context: {
        tenant_slug: input.tenantSlug,
        mission_id: input.lock.mission_id,
        work_shape: 'solution_project',
      },
      metadata: {
        kind: 'customer_decision_rework',
        case_id: input.caseId,
        consumer: input.lock.consumer,
        source_mission_id: input.lock.mission_id,
        source_task_id: input.lock.task_id,
        stale_count: refs.length,
      },
    });
  try {
    // The store checks that the tenant is registered (tenant-registry profile,
    // personal tier). Read it as the tenant-bound registry reader, the
    // infrastructure-metadata role other libs use for that one profile: a
    // customer-triggered respond carries no persona that could read it, and
    // the store fence takes its own role for the item write.
    withExecutionContext(TENANT_REGISTRY_READER_ROLE, create, 'worker', input.tenantSlug);
  } catch (error) {
    // Another boundary filed the same id first (the title may render in another locale).
    if (
      error instanceof WorkCoordinationError &&
      error.code === 'idempotency_conflict' &&
      getWorkItem(itemId, rootDir ? { rootDir } : {})
    ) {
      return itemId;
    }
    throw error;
  }
  return itemId;
}

/** The rework items of a lock that cover any of the given stale entries. */
function coveringReworkIds(
  lock: Pick<ConsumedDecisionLockRecord, 'rework'>,
  stale: readonly StaleConsumedDecision[]
): string[] {
  const refs = new Set(stale.map((entry) => entry.ref));
  return (lock.rework ?? [])
    .filter((entry) => entry.refs.some((ref) => refs.has(ref)))
    .map((entry) => entry.work_item_id);
}

/**
 * File a rework item for the stale entries no item covers yet, then record
 * the check on the lock. Holding the case lock; the role is taken per step.
 */
function settleLock(
  decisionCase: MissionDecisionCase,
  lock: ConsumedDecisionLockRecord,
  result: { checked: number; stale: StaleConsumedDecision[] },
  now: string,
  options: MissionDecisionLockOptions,
  complete: boolean
): TaskDecisionReconciliation {
  const pending = unreworkedStale(lock, result.stale);
  const rework = [...(lock.rework ?? [])];
  if (pending.length > 0) {
    const refs = [...new Set(pending.map((entry) => entry.ref))].sort();
    const workItemId = fileDecisionReworkWorkItem(
      { tenantSlug: decisionCase.tenantSlug, caseId: decisionCase.caseId, lock, refs },
      options
    );
    if (!rework.some((entry) => entry.work_item_id === workItemId)) {
      rework.push({ work_item_id: workItemId, refs, at: now });
    }
  }
  const next: ConsumedDecisionLockRecord = {
    ...lock,
    ...(complete ? { status: 'completed' as const, completed_at: lock.completed_at ?? now } : {}),
    last_check: { at: now, checked: result.checked, stale_count: result.stale.length },
    ...(rework.length > 0 ? { rework } : {}),
  };
  writeLock(decisionCase, next);
  return {
    consumer: lock.consumer,
    checked: result.checked,
    stale_count: result.stale.length,
    rework_work_item_ids: [...new Set(coveringReworkIds(next, result.stale))].sort(),
  };
}

/**
 * Task completion (before the success is recorded): reconcile the task's pin
 * against the current decisions and mark it completed. A stale result does
 * not block completion; it files one rework WorkItem. Zero counts when the
 * mission has no case or the task was never pinned, and on failure (logged).
 */
export function reconcileTaskDecisions(
  input: { missionId: string; taskId: string },
  options: MissionDecisionLockOptions = {}
): TaskDecisionReconciliation {
  const consumer = missionTaskConsumerId(input.missionId, input.taskId);
  try {
    const decisionCase = resolveMissionDecisionCase(input.missionId, options);
    if (!decisionCase) return { ...NOTHING_CHECKED };
    const now = options.now ?? nowIso();
    return withCustomerDecisionCaseLock(decisionCase.location, () => {
      const { agendas, ledger, locks } = readCase(decisionCase, [consumer]);
      const lock = locks[0];
      if (!lock) return { ...NOTHING_CHECKED };
      const result = reconcileConsumedDecisionLock(lock, agendas, ledger, now);
      return settleLock(decisionCase, lock, result, now, options, true);
    });
  } catch (error) {
    warn('customer decision reconciliation skipped', error, consumer);
    return { ...NOTHING_CHECKED, consumer };
  }
}

export interface DecisionConsumerSweepResult {
  stale_consumers: string[];
  rework_work_item_ids: string[];
  /** Held tasks whose customer decisions are now confirmed (present when any). */
  released_holds?: string[];
}

/**
 * Response-time sweep (after `customer-decision respond` recorded switches):
 * completed consumers of the case that pinned a switched entry with a value
 * no longer in force get a rework WorkItem. `switches` defaults to every
 * recorded switch of the agenda (or case), so the sweep is idempotent and the
 * next response retries one that failed. It also releases held tasks whose
 * `requires_customer` proposals now have a confirmed customer decision (run
 * after `respond` and after the operator's `confirm`). Never throws.
 */
export function sweepDecisionConsumers(
  input: {
    tenantSlug: string;
    caseId: string;
    location: CustomerDecisionLocation;
    agendaId?: string;
    switches?: readonly DecisionSwitch[];
  },
  options: MissionDecisionLockOptions = {}
): DecisionConsumerSweepResult {
  const result: DecisionConsumerSweepResult = { stale_consumers: [], rework_work_item_ids: [] };
  try {
    const now = options.now ?? nowIso();
    const decisionCase: MissionDecisionCase = {
      tenantSlug: input.tenantSlug,
      caseId: input.caseId,
      source: 'project',
      location: input.location,
    };
    withCustomerDecisionCaseLock(input.location, () => {
      const snapshot = readCase(decisionCase, 'all', (consumer, error) =>
        warn('customer decision consumer lock unreadable', error, consumer)
      );
      const switches =
        input.switches ??
        snapshot.switches.filter((item) => !input.agendaId || item.agenda_id === input.agendaId);
      const findings =
        switches.length === 0
          ? []
          : findStaleConsumersForSwitches({
              locks: snapshot.locks,
              switches,
              agendas: snapshot.agendas,
              ledger: snapshot.ledger,
              now,
            });
      for (const finding of findings) {
        try {
          const settled = settleLock(
            decisionCase,
            finding.lock,
            { checked: finding.checked, stale: finding.stale },
            now,
            options,
            false
          );
          // Findings only hold entries no rework item covered yet.
          result.stale_consumers.push(finding.lock.consumer);
          result.rework_work_item_ids.push(...settled.rework_work_item_ids);
        } catch (error) {
          warn('customer decision rework filing skipped', error, finding.lock.consumer);
        }
      }
      const released = releaseResolvedHolds(decisionCase, snapshot, now, options);
      if (released.length > 0) result.released_holds = released.sort();
    });
  } catch (error) {
    warn('customer decision consumer sweep skipped', error, `case ${input.caseId}`);
  }
  result.rework_work_item_ids = [...new Set(result.rework_work_item_ids)].sort();
  return result;
}
