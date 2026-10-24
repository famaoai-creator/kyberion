import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import type { ResourceAccessScope } from './resource-access-scope.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Narrow store role for CD-09 task decision locks
 * (`knowledge/confidential/<tenant>/decisions/<case>/consumers/<consumer>.json`,
 * libs/core/mission/mission-decision-lock.ts). Mission processes assume it at
 * task boundaries instead of the full `decision_ledger` role: it may read the
 * case's ledger, switches and agendas and write exactly one consumer lock.
 */
export const CUSTOMER_DECISION_CONSUMER_STORE_ROLE = 'customer_decision_consumer_store';

const CASE_DIR =
  /^knowledge\/confidential\/([a-z][a-z0-9-]{1,30})\/decisions\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;
/** Hermetic tests keep a case in a scratch directory (`{ dir }` locations). */
const SANDBOX_CASE_DIR = /^active\/shared\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/u;
const AGENDA_FILE = /^agendas\/agd-[A-Za-z0-9][A-Za-z0-9_-]{3,80}\.json$/u;
const CONSUMER_FILE =
  /^consumers\/mission-[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/u;
const READABLE = new Set(['decisions.jsonl', 'switches.jsonl', 'agendas', 'consumers']);

/**
 * The response / confirm sweep is a distinct capability kind: only it may list
 * `consumers/` or touch more than one consumer lock, and only while
 * {@link runInCustomerDecisionConsumerSweep} runs (checked when the capability
 * is built and again whenever the guard validates it). A task boundary
 * builds an owner-bound capability and can never obtain the sweep kind by
 * construction. A single consumer file is structurally the same either way.
 */
const SWEEP_KEY = Symbol.for('kyberion.core.customer-decision-consumer-sweep.v1');
const sweepRegistry = globalThis as typeof globalThis & {
  [SWEEP_KEY]?: AsyncLocalStorage<true>;
};
const sweepStorage =
  sweepRegistry[SWEEP_KEY] ?? (sweepRegistry[SWEEP_KEY] = new AsyncLocalStorage());

/** Run the case-wide consumer sweep (`sweepDecisionConsumers` only). */
export function runInCustomerDecisionConsumerSweep<T>(fn: () => T): T {
  return sweepStorage.run(true, fn);
}

function inSweep(): boolean {
  return sweepStorage.getStore() === true;
}

/** Does this access need the sweep kind (a listing, or several consumer locks)? */
function sweepShaped(relatives: readonly string[]): boolean {
  return (
    relatives.includes('consumers') ||
    new Set(relatives.filter((relative) => CONSUMER_FILE.test(relative))).size > 1
  );
}

export interface CustomerDecisionConsumerAccess {
  /** Case-relative paths to read: the ledger, switches, the two listings, agenda and consumer files. */
  read: readonly string[];
  /** Case-relative consumer lock to write (`consumers/<consumer>.json`). */
  write?: string;
  /**
   * A task's own boundary (pin / reconcile / proposals): the only consumer
   * lock it may read or write is `consumers/<owner>.json`, and it may not list
   * `consumers/`. Omitted only by the response / confirm sweep, which
   * reconciles every consumer of the case.
   */
  owner?: string;
}

/** The tenant's decisions root: existence checks only (no reads, no writes). */
const DECISIONS_ROOT = /^knowledge\/confidential\/([a-z][a-z0-9-]{1,30})\/decisions$/u;

/** The repo-relative decisions root of a tenant (`knowledge/confidential/<tenant>/decisions`). */
export function customerDecisionsRootDir(tenantSlug: string): string {
  return `knowledge/confidential/${tenantSlug}/decisions`;
}

function caseDirValid(tenantSlug: string, caseDir: string): boolean {
  if (path.posix.normalize(caseDir) !== caseDir) return false;
  const match = CASE_DIR.exec(caseDir);
  if (match) return match[1] === tenantSlug;
  return Boolean(getProcessEnv('VITEST')) && SANDBOX_CASE_DIR.test(caseDir);
}

function readable(relative: string): boolean {
  return READABLE.has(relative) || AGENDA_FILE.test(relative) || CONSUMER_FILE.test(relative);
}

/**
 * The deny-only ceiling for one consumer-lock operation on one case directory
 * (repo-relative). Reads: only the named ledger / switches / listing / agenda /
 * consumer paths. Writes: at most one consumer lock and its `consumers/`
 * directory. Never the ledger, an agenda, a receipt, the actor registry or
 * anything outside the tenant's own case.
 */
export function customerDecisionConsumerCapability(
  tenantSlug: string,
  caseDir: string,
  access: CustomerDecisionConsumerAccess
): ResourceAccessScope {
  const root = caseDir.match(DECISIONS_ROOT);
  if (root) {
    // Existence of the tenant's decisions root only: a mission with no case
    // at all is left alone after one stat.
    if (root[1] !== tenantSlug || access.read.length > 0 || access.write)
      throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer path');
    return {
      tenantSlug,
      metadataExact: [caseDir],
      readExact: [],
      writeExact: [],
      mkdirExact: [],
      allowProductKnowledgeRead: true,
    };
  }
  if (!isValidTenantSlug(tenantSlug) || !caseDirValid(tenantSlug, caseDir))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer case');
  if (!access.read.every(readable) || (access.write && !CONSUMER_FILE.test(access.write)))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer path');
  if (access.owner !== undefined) {
    const own = `consumers/${access.owner}.json`;
    const foreign = (relative: string) =>
      relative === 'consumers' || (CONSUMER_FILE.test(relative) && relative !== own);
    if (
      !CONSUMER_FILE.test(own) ||
      access.read.some(foreign) ||
      (access.write && foreign(access.write))
    )
      throw new Error(
        '[RESOURCE_SCOPE_INVALID] A task boundary may only touch its own customer decision consumer lock'
      );
  }
  if (
    access.owner === undefined &&
    sweepShaped([...access.read, ...(access.write ? [access.write] : [])]) &&
    !inSweep()
  )
    throw new Error(
      '[RESOURCE_SCOPE_INVALID] Only the customer decision consumer sweep may touch other consumer locks'
    );
  const inCase = (relative: string) => `${caseDir}/${relative}`;
  const read = [...new Set([...access.read, ...(access.write ? [access.write] : [])])].sort();
  return {
    tenantSlug,
    metadataExact: [caseDir],
    readExact: read.map(inCase),
    writeExact: access.write ? [inCase(access.write)] : [],
    mkdirExact: access.write ? [inCase('consumers')] : [],
    allowProductKnowledgeRead: true,
  };
}

export function isCustomerDecisionConsumerCapability(
  scope: ResourceAccessScope | undefined
): boolean {
  if (
    !scope ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead !== true ||
    scope.metadataExact?.length !== 1 ||
    scope.writeExact.length > 1
  )
    return false;
  const caseDir = scope.metadataExact[0]!;
  const prefix = `${caseDir}/`;
  const relative = (target: string) =>
    target.startsWith(prefix) ? target.slice(prefix.length) : '';
  try {
    // The sweep kind is valid only inside the sweep.
    if (sweepShaped(scope.readExact.map(relative)) && !inSweep()) return false;
    const write = scope.writeExact[0] ? relative(scope.writeExact[0]) : undefined;
    const expected = customerDecisionConsumerCapability(scope.tenantSlug, caseDir, {
      read: scope.readExact.map(relative),
      ...(write !== undefined ? { write } : {}),
    });
    return (
      JSON.stringify([...scope.readExact].sort()) === JSON.stringify(expected.readExact) &&
      JSON.stringify(scope.writeExact) === JSON.stringify(expected.writeExact) &&
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact)
    );
  } catch {
    return false;
  }
}

/** Raw text of a case-relative file (`decisions.jsonl`, `agendas/<id>.json`), undefined when absent. */
export type CustomerDecisionCaseFileReader = (relative: string) => string | undefined;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as JsonRecord)
      .sort()
      .reduce<JsonRecord>((acc, key) => {
        acc[key] = sortKeys((value as JsonRecord)[key]);
        return acc;
      }, {});
  }
  return value;
}

const canonical = (value: unknown) => JSON.stringify(sortKeys(value));

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const entries = (lock: JsonRecord): JsonRecord[] =>
  Array.isArray(lock.decisions)
    ? lock.decisions.map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry))
    : [];

/** `task_proposal` entries by proposal id. */
function proposalsOf(lock: JsonRecord): Map<string, JsonRecord> {
  const byId = new Map<string, JsonRecord>();
  for (const entry of entries(lock)) {
    const proposal = asRecord(entry.proposal);
    if (entry.layer === 'task_proposal' && typeof proposal?.proposal_id === 'string')
      byId.set(proposal.proposal_id, entry);
  }
  return byId;
}

const proposalOf = (entry: JsonRecord): JsonRecord => asRecord(entry.proposal) ?? {};

function withoutResolution(entry: JsonRecord): JsonRecord {
  const { resolved: _resolved, ...proposal } = proposalOf(entry);
  void _resolved;
  return { ...entry, proposal };
}

/**
 * A `resolved` stamp on a task proposal releases the task (CD-09): it must
 * name a customer decision the operator confirmed on the proposal's own agenda
 * entry (`agenda.operator_confirmations`, which this role can never write) and
 * that the case ledger records as the customer's decided value of the
 * proposal's item × key.
 */
function resolutionProblem(entry: JsonRecord, read: CustomerDecisionCaseFileReader): string | null {
  const decisionId = asRecord(proposalOf(entry).resolved)?.decision_id;
  const agendaId = entry.agenda_id;
  const entryId = entry.entry_id;
  const agendaFile = `agendas/${String(agendaId)}.json`;
  if (
    typeof decisionId !== 'string' ||
    typeof agendaId !== 'string' ||
    typeof entryId !== 'string' ||
    !AGENDA_FILE.test(agendaFile)
  )
    return 'a resolved task proposal must name its agenda entry and decision';
  const agenda = asRecord(parseJson(read(agendaFile)));
  const confirmed =
    Array.isArray(agenda?.operator_confirmations) &&
    agenda.operator_confirmations.some((item) => {
      const confirmation = asRecord(item);
      return confirmation?.entry_id === entryId && confirmation.decision_id === decisionId;
    });
  if (!confirmed)
    return 'a task proposal may be resolved only by a customer decision the operator confirmed';
  const recorded = (read('decisions.jsonl') ?? '').split('\n').some((line) => {
    const record = asRecord(parseJson(line.trim() || undefined));
    return (
      record?.id === decisionId &&
      record.item === entry.item &&
      record.key === entry.key &&
      record.level === 'customer-value' &&
      record.state === 'decided'
    );
  });
  return recorded
    ? null
    : 'a task proposal may be resolved only by the customer decision the ledger records for it';
}

const IDENTITY_FIELDS = ['version', 'case_id', 'consumer', 'mission_id', 'task_id', 'tenant_slug'];

/**
 * The guard-side content rule of a consumer store write (CD-09), enforced by
 * the tier guard on every write the role makes through secure-io, comparing
 * the new lock with the one on disk. A process holding the capability can
 * therefore not undo what the lock records:
 *   - identity (case, consumer, mission, task, tenant, project) never changes;
 *   - a lock that stays completed keeps its `completed_at` and its pinned
 *     decisions (the response sweep checks them). `status` may go back to
 *     `in_progress` (a new worker run re-pins the task) with new pins, keeping
 *     every record below. The guard cannot tell that re-pin from a forged
 *     "re-run": a holder of the capability can re-pin and complete again
 *     (completed → in_progress → completed) to replace a completed lock's
 *     pins. Known limit (plan, CD-09 の残り);
 *   - `rework` is append-only;
 *   - `task_proposal` entries are never removed, never lose
 *     `requires_customer`, never lose `resolved`; a collected one changes only
 *     by gaining `resolved`, and a new `resolved` must name an
 *     operator-confirmed customer decision ({@link resolutionProblem});
 *   - a `hold` is never removed, keeps its `at` and WorkItem, and gets
 *     `resolved_at` only when every requires_customer proposal is resolved
 *     (it may be re-opened);
 *   - a new lock starts `in_progress` with no rework.
 * Returns the refusal reason, or null when the change is allowed.
 */
export function customerDecisionConsumerWriteProblem(
  relative: string,
  previous: unknown,
  next: unknown,
  read: CustomerDecisionCaseFileReader
): string | null {
  const refused = (why: string) => `[CUSTOMER_DECISION_CONSUMER_WRITE_REFUSED] ${why}`;
  const after = asRecord(next);
  if (!after) return refused('the new consumer lock is not a JSON object');
  if (relative !== `consumers/${String(after.consumer)}.json`)
    return refused('the consumer lock does not match its file');
  if (after.status !== 'in_progress' && after.status !== 'completed')
    return refused('invalid consumer lock status');
  const before = previous === undefined ? undefined : asRecord(previous);
  if (previous !== undefined && !before)
    return refused('the consumer lock on disk is unreadable; it is not replaced');
  if (!before) {
    if (after.status !== 'in_progress' || after.completed_at !== undefined)
      return refused('a new consumer lock starts in progress');
    if (Array.isArray(after.rework) && after.rework.length > 0)
      return refused('a new consumer lock has no rework');
  } else {
    for (const field of IDENTITY_FIELDS)
      if (canonical(after[field]) !== canonical(before[field]))
        return refused(`the consumer lock ${field} may not change`);
    if (before.project_id !== undefined && after.project_id !== before.project_id)
      return refused('the consumer lock project_id may not change');
    // A completed lock may go back to in_progress (a worker re-run re-pins it);
    // the guard cannot prove that run is real (see the docstring).
    if (before.status === 'completed' && after.status === 'completed') {
      if (after.completed_at !== before.completed_at)
        return refused('a completed consumer lock keeps its completed_at');
      const pins = (lock: JsonRecord) => entries(lock).filter((e) => e.layer !== 'task_proposal');
      if (canonical(pins(before)) !== canonical(pins(after)))
        return refused('the pinned decisions of a completed consumer lock may not change');
    }
    const was = Array.isArray(before.rework) ? before.rework : [];
    const now = Array.isArray(after.rework) ? after.rework : [];
    if (
      now.length < was.length ||
      was.some((item, index) => canonical(item) !== canonical(now[index]))
    )
      return refused('rework records are append-only');
  }
  const previousProposals = before ? proposalsOf(before) : new Map<string, JsonRecord>();
  const nextProposals = proposalsOf(after);
  for (const [id, was] of previousProposals) {
    const now = nextProposals.get(id);
    if (!now) return refused('task proposals may not be removed');
    if (now.item !== was.item || now.key !== was.key)
      return refused('a task proposal keeps its item and key');
    const wasProposal = proposalOf(was);
    const nowProposal = proposalOf(now);
    if (wasProposal.requires_customer === true && nowProposal.requires_customer !== true)
      return refused('a task proposal never loses requires_customer');
    if (
      wasProposal.resolved !== undefined &&
      canonical(nowProposal.resolved) !== canonical(wasProposal.resolved)
    )
      return refused('a resolved task proposal stays resolved');
    if (
      was.agenda_id !== undefined &&
      canonical(withoutResolution(was)) !== canonical(withoutResolution(now))
    )
      return refused('a collected task proposal may only gain its resolution');
  }
  for (const [id, now] of nextProposals) {
    if (proposalOf(now).resolved === undefined) continue;
    if (proposalOf(previousProposals.get(id) ?? {}).resolved !== undefined) continue;
    const problem = resolutionProblem(now, read);
    if (problem) return refused(problem);
  }
  const wasHold = before ? asRecord(before.hold) : undefined;
  const nowHold = asRecord(after.hold);
  if (after.hold !== undefined && !nowHold) return refused('invalid hold');
  if (wasHold) {
    if (!nowHold) return refused('a hold may not be removed');
    if (nowHold.at !== wasHold.at) return refused('a hold keeps its start');
    if (wasHold.work_item_id !== undefined && nowHold.work_item_id !== wasHold.work_item_id)
      return refused('a hold keeps its WorkItem');
  }
  if (nowHold?.resolved_at !== undefined) {
    if (wasHold?.resolved_at !== undefined) {
      if (nowHold.resolved_at !== wasHold.resolved_at)
        return refused('a resolved hold keeps its resolution');
    } else if (
      [...nextProposals.values()].some(
        (entry) =>
          proposalOf(entry).requires_customer === true && proposalOf(entry).resolved === undefined
      )
    ) {
      return refused('a hold is resolved only when every requires_customer proposal is resolved');
    }
  }
  return null;
}
