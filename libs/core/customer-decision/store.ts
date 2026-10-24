/**
 * Customer decision storage (CD-01). Everything lives under the SSOD case
 * directory, next to the decision ledger that holds the values:
 *
 *   knowledge/confidential/<tenant>/decisions/<case>/agendas/<agenda_id>.json
 *   knowledge/confidential/<tenant>/decisions/<case>/receipts/<receipt_id>.json   immutable
 *   knowledge/confidential/<tenant>/decisions/<case>/switches.jsonl               append-only
 *   knowledge/confidential/<tenant>/decisions/<case>/respond-journal/<receipt_id>.json  write-ahead, removed when done
 *   knowledge/confidential/<tenant>/decisions/<case>/consumers/<consumer>.json    CD-09 task decision locks
 *   knowledge/confidential/<tenant>/decisions/<case>/attachments/<sha256>.<ext>   CD-10 entry images, immutable
 *
 * Every read-plan-write sequence on a case (agenda edits, approval pins, sends,
 * responses, confirmations, close / withdraw) runs under one inter-process
 * lock per tenant + case ({@link withCustomerDecisionCaseLock}), so two
 * concurrent responses can never lose a decision or both write a receipt for
 * one double submit. The case lock also holds the decision ledger's own lock
 * (`withDecisionLedgerLock`, taken inside every ledger write) for the whole
 * sequence, so a concurrent `pnpm decisions` writer — which takes only the
 * ledger lock — queues behind it and cannot invalidate the decision ids a
 * respond pre-assigns in its journal. Lock order is always case → ledger;
 * the ledger lock never takes the case lock, so the order cannot invert.
 *
 * The respond journal stays beside the ledger (not on the runtime floor): it
 * guards the ledger records it pre-assigns, so it is written and read under
 * the same `decision_ledger` role, the same tenant scope and the same locks
 * as those records, and it holds the same confidential data (the receipt).
 * It is removed when the run completes; a leftover record is a run that
 * `reconcileCase` must still finish, never stale cache.
 *
 * Nothing goes under `system/`. All I/O goes through secure-io, every record is
 * schema-validated on write and on read, and the location reuses the ledger's
 * `ledgerDir` (tenant slug + case id validation, `{ dir }` for hermetic tests).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../core.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safePublishExclusiveFileSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
  safeRmSync,
} from '../secure-io.js';
import { resolveRole } from '../authority.js';
import { CUSTOMER_DECISION_MILESTONE_STORE_ROLE } from '../foundation/customer-decision-milestone-capability.js';
import {
  CASE_ID_PATTERN,
  CUSTOMER_SLUG_PATTERN,
  DECISION_LEDGER_LAYOUT,
  canonicalJson,
} from '../decision-ledger/model.js';
import {
  ledgerDir,
  withDecisionLedgerLock,
  type DecisionLedgerLocation,
} from '../decision-ledger/ledger.js';
import {
  ATTACHMENT_ID_PATTERN,
  MAX_ATTACHMENT_BYTES,
  attachmentExtension,
  checkAttachmentBytes,
  linkProblem,
} from './bolt-review.js';
import {
  AGENDA_ID_PATTERN,
  CONSUMER_ID_PATTERN,
  CUSTOMER_DECISION_LAYOUT,
  RECEIPT_ID_PATTERN,
  type AgendaAttachment,
  type AgendaAttachmentMediaType,
  type ConsumedDecisionLock,
  type DecisionAgenda,
  type DecisionReceipt,
  type DecisionSwitch,
  type EffectiveDecision,
} from './model.js';
import { LEARNING_REPORT_DATE_PATTERN, type CustomerDecisionLearningReport } from './learning.js';

/** Same shape as the ledger location: a tenant + case, or a test `dir`. */
export type CustomerDecisionLocation = DecisionLedgerLocation;

const SCHEMA_FILES = {
  agenda: 'knowledge/product/schemas/customer-decision-agenda.schema.json',
  receipt: 'knowledge/product/schemas/customer-decision-receipt.schema.json',
  switch: 'knowledge/product/schemas/customer-decision-switch.schema.json',
  journal: 'knowledge/product/schemas/customer-decision-respond-journal.schema.json',
  consumer: 'knowledge/product/schemas/customer-decision-consumer-lock.schema.json',
  learning_report: 'knowledge/product/schemas/customer-decision-learning-report.schema.json',
} as const;

type SchemaName = keyof typeof SCHEMA_FILES;
const catalogs = new Map<SchemaName, GovernedCatalog<unknown>>();

function validate<T>(name: SchemaName, value: unknown): T {
  let catalog = catalogs.get(name);
  if (!catalog) {
    const schemaPath = pathResolver.rootResolve(SCHEMA_FILES[name]);
    catalog = defineCatalog<unknown>({
      id: `customer-decision-${name}`,
      path: schemaPath,
      schema: schemaPath,
    });
    catalogs.set(name, catalog);
  }
  return catalog.validate(value) as T;
}

export function newAgendaId(): string {
  return `agd-${randomBytes(8).toString('hex')}`;
}

export function newReceiptId(): string {
  return `rcp-${randomBytes(8).toString('hex')}`;
}

export function newSwitchId(): string {
  return `sw-${randomBytes(8).toString('hex')}`;
}

export function customerDecisionPaths(location: CustomerDecisionLocation) {
  const dir = ledgerDir(location);
  return {
    dir,
    agendas: path.join(dir, CUSTOMER_DECISION_LAYOUT.agendasDir),
    receipts: path.join(dir, CUSTOMER_DECISION_LAYOUT.receiptsDir),
    respondJournal: path.join(dir, CUSTOMER_DECISION_LAYOUT.respondJournalDir),
    consumers: path.join(dir, CUSTOMER_DECISION_LAYOUT.consumersDir),
    attachments: path.join(dir, CUSTOMER_DECISION_LAYOUT.attachmentsDir),
    switches: path.join(dir, CUSTOMER_DECISION_LAYOUT.files.switches),
  };
}

function agendaPath(location: CustomerDecisionLocation, agendaId: string): string {
  if (!AGENDA_ID_PATTERN.test(agendaId))
    throw new Error('[CUSTOMER_DECISION_AGENDA_ID_INVALID] invalid agenda id');
  return path.join(customerDecisionPaths(location).agendas, `${agendaId}.json`);
}

function receiptPath(location: CustomerDecisionLocation, receiptId: string): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId))
    throw new Error('[CUSTOMER_DECISION_RECEIPT_ID_INVALID] invalid receipt id');
  return path.join(customerDecisionPaths(location).receipts, `${receiptId}.json`);
}

/** A record must belong to the tenant and case its location names. */
function assertBelongs(
  location: CustomerDecisionLocation,
  record: { tenant_slug?: string; case_id: string },
  kind: string
): void {
  if ('dir' in location) return;
  if (record.case_id !== location.caseId)
    throw new Error(`[CUSTOMER_DECISION_CASE_MISMATCH] ${kind} case does not match location`);
  if (record.tenant_slug !== undefined && record.tenant_slug !== location.tenantSlug)
    throw new Error(`[CUSTOMER_DECISION_TENANT_MISMATCH] ${kind} tenant does not match location`);
}

function readRecord(file: string): unknown {
  const safe = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  return readJsonIfPresent<unknown>(safe) ?? undefined;
}

/** Ensure the parent directory and return the guarded path. */
function prepareWrite(file: string): string {
  const safe = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  safeMkdir(path.dirname(safe), { recursive: true });
  return safe;
}

function listJsonIds(dir: string, pattern: RegExp): string[] {
  const safe = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(safe)) return [];
  return safeReaddir(safe)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => pattern.test(id))
    .sort();
}

// ---------------------------------------------------------------------------
// Agendas (mutable through their lifecycle; content changes bump the revision)
// ---------------------------------------------------------------------------

export function readAgenda(
  location: CustomerDecisionLocation,
  agendaId: string
): DecisionAgenda | undefined {
  const raw = readRecord(agendaPath(location, agendaId));
  if (raw === undefined) return undefined;
  const agenda = validate<DecisionAgenda>('agenda', raw);
  if (agenda.agenda_id !== agendaId)
    throw new Error('[CUSTOMER_DECISION_AGENDA_ID_MISMATCH] agenda id does not match its file');
  assertBelongs(location, agenda, 'agenda');
  return agenda;
}

/**
 * Every entry link must be one a customer may be sent (CD-10): public https
 * only, never an internal host. Checked on every agenda write, so neither
 * `draft --file` nor a hand-edited record can carry one to submit / send.
 */
export function assertAgendaLinks(agenda: Pick<DecisionAgenda, 'entries'>): void {
  for (const entry of agenda.entries) {
    for (const link of entry.links ?? []) {
      const problem = linkProblem(link.url);
      if (problem)
        throw new Error(
          `[CUSTOMER_DECISION_LINK_REFUSED] entry ${entry.entry_id}: ${problem} — only a public https URL may be shown to a customer`
        );
    }
  }
}

/** The agenda without the fields a milestone write may change. */
function withoutMilestones(
  agenda: DecisionAgenda
): Omit<DecisionAgenda, 'milestones_passed' | 'updated_at'> {
  const { milestones_passed: _passed, updated_at: _updated, ...rest } = agenda;
  void _passed;
  void _updated;
  return rest;
}

/**
 * Is `next` exactly `previous` plus milestones appended to `milestones_passed`
 * (and a new `updated_at`)? The only agenda change the milestone store role
 * may make (CD-10).
 */
export function isMilestoneOnlyChange(previous: DecisionAgenda, next: DecisionAgenda): boolean {
  const before = previous.milestones_passed ?? [];
  const after = next.milestones_passed ?? [];
  return (
    after.length > before.length &&
    before.every((milestone, index) => after[index] === milestone) &&
    canonicalJson(withoutMilestones(previous)) === canonicalJson(withoutMilestones(next))
  );
}

export function writeAgenda(
  location: CustomerDecisionLocation,
  agenda: DecisionAgenda
): DecisionAgenda {
  const validated = validate<DecisionAgenda>('agenda', agenda);
  assertBelongs(location, validated, 'agenda');
  assertAgendaLinks(validated);
  const file = agendaPath(location, validated.agenda_id);
  if (resolveRole() === CUSTOMER_DECISION_MILESTONE_STORE_ROLE) {
    // The milestone role (a shared core role) may only append milestones to an
    // existing agenda: re-read it here and refuse any other change.
    const previous = readAgenda(location, validated.agenda_id);
    if (!previous || !isMilestoneOnlyChange(previous, validated))
      throw new Error(
        '[CUSTOMER_DECISION_MILESTONE_WRITE_REFUSED] the milestone store may only append to milestones_passed'
      );
  }
  writeJson(prepareWrite(file), validated);
  return validated;
}

/**
 * CD-10: append a milestone to an agenda's `milestones_passed` — the write
 * path of the milestone store role. Re-reads the agenda (call holding the
 * case lock); null when the agenda is missing or already has the milestone.
 */
export function markAgendaMilestonePassed(
  location: CustomerDecisionLocation,
  agendaId: string,
  milestone: string,
  now: string
): DecisionAgenda | null {
  const current = readAgenda(location, agendaId);
  if (!current || (current.milestones_passed ?? []).includes(milestone)) return null;
  return writeAgenda(location, {
    ...current,
    milestones_passed: [...(current.milestones_passed ?? []), milestone],
    updated_at: now,
  });
}

/** Agenda ids of a case (a listing of `agendas/`, no record is read). */
export function listAgendaIds(location: CustomerDecisionLocation): string[] {
  return listJsonIds(customerDecisionPaths(location).agendas, AGENDA_ID_PATTERN);
}

export function listAgendas(location: CustomerDecisionLocation): DecisionAgenda[] {
  const agendas: DecisionAgenda[] = [];
  for (const id of listJsonIds(customerDecisionPaths(location).agendas, AGENDA_ID_PATTERN)) {
    const agenda = readAgenda(location, id);
    if (agenda) agendas.push(agenda);
  }
  return agendas;
}

// ---------------------------------------------------------------------------
// Attachments (CD-10; immutable, content-addressed: the id is the sha256)
// ---------------------------------------------------------------------------

function attachmentPath(
  location: CustomerDecisionLocation,
  id: string,
  mediaType: AgendaAttachmentMediaType
): string {
  if (!ATTACHMENT_ID_PATTERN.test(id))
    throw new Error('[CUSTOMER_DECISION_ATTACHMENT_ID_INVALID] invalid attachment id');
  return path.join(
    customerDecisionPaths(location).attachments,
    `${id}.${attachmentExtension(mediaType)}`
  );
}

/**
 * Store an entry image after checking it (size, png / jpeg / webp, the name's
 * type matches the bytes). Content-addressed: storing the same bytes again
 * returns the same record without a write. Throws `[CUSTOMER_DECISION_ATTACHMENT_*]`.
 */
export function writeAgendaAttachment(
  location: CustomerDecisionLocation,
  name: string,
  bytes: Uint8Array
): AgendaAttachment {
  const checked = checkAttachmentBytes(name, bytes);
  if (checked.ok === false)
    throw new Error(
      `[CUSTOMER_DECISION_ATTACHMENT_${checked.problem.toUpperCase()}] attachment refused: ${checked.problem}`
    );
  const file = prepareWrite(attachmentPath(location, checked.id, checked.media_type));
  if (!safeExistsSync(file)) {
    try {
      safePublishExclusiveFileSync(file, Buffer.from(bytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return {
    id: checked.id,
    name: path.basename(name).slice(0, 200),
    media_type: checked.media_type,
    bytes: bytes.length,
  };
}

/**
 * The bytes of a stored attachment, re-checked against its id and type, or
 * undefined when it is missing or does not match.
 */
export function readAgendaAttachment(
  location: CustomerDecisionLocation,
  attachment: Pick<AgendaAttachment, 'id' | 'media_type'>
): Buffer | undefined {
  const file = assertSafeRepositoryPath(
    attachmentPath(location, attachment.id, attachment.media_type),
    { allowMissingLeaf: true }
  );
  if (!safeExistsSync(file)) return undefined;
  const bytes = safeReadFile(file, {
    encoding: null,
    maxSizeMB: MAX_ATTACHMENT_BYTES / (1024 * 1024),
  }) as Buffer;
  const checked = checkAttachmentBytes(`a.${attachmentExtension(attachment.media_type)}`, bytes);
  if (checked.ok === false || checked.id !== attachment.id) return undefined;
  return bytes;
}

// ---------------------------------------------------------------------------
// Receipts (immutable: a second write with the same id is refused)
// ---------------------------------------------------------------------------

export function writeReceipt(
  location: CustomerDecisionLocation,
  receipt: DecisionReceipt
): DecisionReceipt {
  const validated = validate<DecisionReceipt>('receipt', receipt);
  assertBelongs(location, validated, 'receipt');
  const file = prepareWrite(receiptPath(location, validated.receipt_id));
  if (safeExistsSync(file))
    throw new Error('[CUSTOMER_DECISION_RECEIPT_EXISTS] receipts are immutable');
  writeJson(file, validated, { createOnly: true });
  return validated;
}

export function readReceipt(
  location: CustomerDecisionLocation,
  receiptId: string
): DecisionReceipt | undefined {
  const raw = readRecord(receiptPath(location, receiptId));
  if (raw === undefined) return undefined;
  const receipt = validate<DecisionReceipt>('receipt', raw);
  if (receipt.receipt_id !== receiptId)
    throw new Error('[CUSTOMER_DECISION_RECEIPT_ID_MISMATCH] receipt id does not match its file');
  assertBelongs(location, receipt, 'receipt');
  return receipt;
}

export function listReceipts(
  location: CustomerDecisionLocation,
  filter: { agendaId?: string } = {}
): DecisionReceipt[] {
  const receipts: DecisionReceipt[] = [];
  for (const id of listJsonIds(customerDecisionPaths(location).receipts, RECEIPT_ID_PATTERN)) {
    const receipt = readReceipt(location, id);
    if (!receipt) continue;
    if (filter.agendaId && receipt.agenda_id !== filter.agendaId) continue;
    receipts.push(receipt);
  }
  return receipts.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
}

// ---------------------------------------------------------------------------
// Switches (append-only JSONL; reads skip corrupt lines)
// ---------------------------------------------------------------------------

export function appendSwitches(
  location: CustomerDecisionLocation,
  switches: readonly DecisionSwitch[]
): DecisionSwitch[] {
  const validated = switches.map((item) => {
    const record = validate<DecisionSwitch>('switch', item);
    assertBelongs(location, record, 'switch');
    return record;
  });
  if (validated.length === 0) return validated;
  const file = prepareWrite(customerDecisionPaths(location).switches);
  for (const record of validated) appendJsonLine(file, record);
  return validated;
}

export function readSwitches(
  location: CustomerDecisionLocation,
  filter: { agendaId?: string } = {}
): DecisionSwitch[] {
  const file = assertSafeRepositoryPath(customerDecisionPaths(location).switches, {
    allowMissingLeaf: true,
  });
  const switches = readJsonLines<DecisionSwitch>(file, {
    map: (value) => validate<DecisionSwitch>('switch', value),
    onMalformed: (error, lineNumber) => {
      logger.warn(
        `customer decision switch line ${lineNumber} skipped — ${error instanceof Error ? error.message : String(error)} | repair or remove the line | switches.jsonl`
      );
    },
  });
  return filter.agendaId
    ? switches.filter((record) => record.agenda_id === filter.agendaId)
    : switches;
}

// ---------------------------------------------------------------------------
// Case lock (inter-process; one per tenant + case)
// ---------------------------------------------------------------------------

/**
 * Total wait for both locks (case, then ledger): long enough to queue behind a
 * respond, leaving room for the work itself inside the customer room's 15 s
 * child limit.
 */
export const CUSTOMER_DECISION_CASE_LOCK_TIMEOUT_MS = 8_000;

/** The lock resource of a case: tenant + case, or a hash of a test `dir`. */
export function customerDecisionCaseLockId(location: CustomerDecisionLocation): string {
  if ('dir' in location) {
    const dir = customerDecisionPaths(location).dir;
    return `customer-decision-case-dir-${createHash('sha256').update(dir).digest('hex').slice(0, 24)}`;
  }
  // Validates the tenant slug and case id.
  customerDecisionPaths(location);
  return `customer-decision-case-${location.tenantSlug}-${location.caseId}`;
}

/**
 * Run `fn` holding the case lock, then the case's ledger lock (order: case →
 * ledger). The lock files live under `active/shared/runtime/locks/`
 * (security-policy default_allow), so take it under the caller's own
 * identity, OUTSIDE any narrow store role, and do all reads, planning and
 * writes of the sequence inside `fn`. The case lock is not re-entrant; the
 * ledger lock is (ledger writes inside `fn` re-enter it).
 */
export function withCustomerDecisionCaseLock<T>(
  location: CustomerDecisionLocation,
  fn: () => T,
  timeoutMs = CUSTOMER_DECISION_CASE_LOCK_TIMEOUT_MS
): T {
  // One deadline for both waits: the ledger lock gets whatever the case lock left.
  const deadline = Date.now() + timeoutMs;
  return withLockSync(
    customerDecisionCaseLockId(location),
    () => withDecisionLedgerLock(location, fn, Math.max(1, deadline - Date.now())),
    timeoutMs
  );
}

/**
 * Run `fn` holding the lock of a customer's actor registry
 * (`customers/<customer>/actors.json`), which every case of that customer
 * shares, so the case lock does not cover it. Same identity rule as the case
 * lock: take it outside the store role and re-read the registry inside `fn`.
 */
export function withCustomerActorsLock<T>(
  tenantSlug: string,
  customer: string,
  fn: () => T,
  timeoutMs = CUSTOMER_DECISION_CASE_LOCK_TIMEOUT_MS
): T {
  if (!isValidTenantSlug(tenantSlug) || !CUSTOMER_SLUG_PATTERN.test(customer)) {
    throw new Error('[CUSTOMER_DECISION_ACTORS_LOCK_INVALID] invalid tenant or customer slug');
  }
  return withLockSync(`customer-decision-actors-${tenantSlug}-${customer}`, fn, timeoutMs);
}

// ---------------------------------------------------------------------------
// Respond journal (write-ahead record of one respond run)
// ---------------------------------------------------------------------------

/**
 * The last step of a respond run known to be done. `auditing` is written just
 * before the audit entry: a run found there may or may not have recorded it,
 * so completion checks the audit chain first (never a second entry).
 */
export type RespondJournalStage =
  'planned' | 'ledger_written' | 'receipt_written' | 'auditing' | 'audited';

export interface RespondJournalRecord {
  version: '1.0.0';
  receipt_id: string;
  tenant_slug: string;
  case_id: string;
  agenda_id: string;
  stage: RespondJournalStage;
  /** The receipt the run writes; its `decision_ids` are assigned before the ledger write. */
  receipt: DecisionReceipt;
  /** Effective decisions before the ledger write (switch detection on completion). */
  before: EffectiveDecision[];
  created_at: string;
  updated_at: string;
}

function journalPath(location: CustomerDecisionLocation, receiptId: string): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId))
    throw new Error('[CUSTOMER_DECISION_RECEIPT_ID_INVALID] invalid receipt id');
  return path.join(customerDecisionPaths(location).respondJournal, `${receiptId}.json`);
}

function validateJournal(value: unknown): RespondJournalRecord {
  const record = validate<RespondJournalRecord>('journal', value);
  validate<DecisionReceipt>('receipt', record.receipt);
  if (record.receipt.receipt_id !== record.receipt_id)
    throw new Error('[CUSTOMER_DECISION_JOURNAL_MISMATCH] journal and receipt ids differ');
  return record;
}

/** Write (or advance) a respond journal record. */
export function writeRespondJournal(
  location: CustomerDecisionLocation,
  record: RespondJournalRecord
): RespondJournalRecord {
  const validated = validateJournal(record);
  assertBelongs(location, validated, 'respond journal');
  writeJson(prepareWrite(journalPath(location, validated.receipt_id)), validated);
  return validated;
}

/**
 * Respond runs that did not finish, oldest first. A record that cannot be read
 * is reported through `onInvalid` and skipped, never deleted.
 */
export function listRespondJournals(
  location: CustomerDecisionLocation,
  onInvalid: (receiptId: string, error: unknown) => void = () => undefined
): RespondJournalRecord[] {
  const records: RespondJournalRecord[] = [];
  for (const id of listJsonIds(
    customerDecisionPaths(location).respondJournal,
    RECEIPT_ID_PATTERN
  )) {
    try {
      const raw = readRecord(journalPath(location, id));
      if (raw === undefined) continue;
      const record = validateJournal(raw);
      assertBelongs(location, record, 'respond journal');
      if (record.receipt_id !== id)
        throw new Error('[CUSTOMER_DECISION_JOURNAL_MISMATCH] journal id does not match its file');
      records.push(record);
    } catch (error) {
      onInvalid(id, error);
    }
  }
  return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Remove a finished respond journal record. */
export function removeRespondJournal(location: CustomerDecisionLocation, receiptId: string): void {
  const file = assertSafeRepositoryPath(journalPath(location, receiptId), {
    allowMissingLeaf: true,
  });
  safeRmSync(file, { force: true });
}

// ---------------------------------------------------------------------------
// Consumer locks (CD-09: what a mission task consumed at its start)
// ---------------------------------------------------------------------------

/** A task's lock is open while it runs and completed once its result was checked. */
export type ConsumedDecisionLockStatus = 'in_progress' | 'completed';

/** The stored form of a {@link ConsumedDecisionLock} (`consumers/<consumer>.json`). */
export interface ConsumedDecisionLockRecord extends ConsumedDecisionLock {
  version: '1.0.0';
  tenant_slug?: string;
  /** The mission's project: the typed context of a rework WorkItem filed for this consumer. */
  project_id?: string;
  mission_id: string;
  task_id: string;
  status: ConsumedDecisionLockStatus;
  completed_at?: string;
  /** The last reconciliation: counts only. */
  last_check?: { at: string; checked: number; stale_count: number };
  /** Rework WorkItems filed for this consumer and the current decisions each one names. */
  rework?: Array<{ work_item_id: string; refs: string[]; at: string }>;
  /**
   * The task waits for the customer (a `requires_customer` task proposal);
   * `resolved_at` once every held proposal has a confirmed customer decision.
   */
  hold?: { work_item_id?: string; at: string; resolved_at?: string };
}

function consumerPath(location: CustomerDecisionLocation, consumer: string): string {
  if (!CONSUMER_ID_PATTERN.test(consumer))
    throw new Error('[CUSTOMER_DECISION_CONSUMER_ID_INVALID] invalid consumer id');
  return path.join(customerDecisionPaths(location).consumers, `${consumer}.json`);
}

export function readConsumedDecisionLock(
  location: CustomerDecisionLocation,
  consumer: string
): ConsumedDecisionLockRecord | undefined {
  const raw = readRecord(consumerPath(location, consumer));
  if (raw === undefined) return undefined;
  const lock = validate<ConsumedDecisionLockRecord>('consumer', raw);
  if (lock.consumer !== consumer)
    throw new Error('[CUSTOMER_DECISION_CONSUMER_MISMATCH] consumer id does not match its file');
  assertBelongs(location, lock, 'consumer lock');
  return lock;
}

/** Write (or replace) a consumer lock. Call holding the case lock. */
export function writeConsumedDecisionLock(
  location: CustomerDecisionLocation,
  lock: ConsumedDecisionLockRecord
): ConsumedDecisionLockRecord {
  const validated = validate<ConsumedDecisionLockRecord>('consumer', lock);
  assertBelongs(location, validated, 'consumer lock');
  writeJson(prepareWrite(consumerPath(location, validated.consumer)), validated);
  return validated;
}

/** Consumer ids of a case (a listing of `consumers/`, no record is read). */
export function listConsumedDecisionLockIds(location: CustomerDecisionLocation): string[] {
  return listJsonIds(customerDecisionPaths(location).consumers, CONSUMER_ID_PATTERN);
}

/** Every consumer lock of a case. A record that cannot be read is reported and skipped. */
export function listConsumedDecisionLocks(
  location: CustomerDecisionLocation,
  onInvalid: (consumer: string, error: unknown) => void = () => undefined
): ConsumedDecisionLockRecord[] {
  const locks: ConsumedDecisionLockRecord[] = [];
  for (const id of listConsumedDecisionLockIds(location)) {
    try {
      const lock = readConsumedDecisionLock(location, id);
      if (lock) locks.push(lock);
    } catch (error) {
      onInvalid(id, error);
    }
  }
  return locks;
}

// ---------------------------------------------------------------------------
// Tenant-wide views (CD-12): the case listing and the learning reports
// ---------------------------------------------------------------------------

/**
 * Tenant reports live beside the cases, under `decisions/_reports/`. The
 * leading underscore keeps the directory outside the case id grammar
 * (`CASE_ID_PATTERN` starts with a letter or digit), so it is never listed or
 * resolved as a case.
 */
export const CUSTOMER_DECISION_REPORTS_DIR = '_reports';

function tenantDecisionsRoot(tenantSlug: string): string {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[CUSTOMER_DECISION_TENANT_INVALID] invalid tenant slug');
  return assertSafeRepositoryPath(
    path.join(
      pathResolver.rootDir(),
      DECISION_LEDGER_LAYOUT.confidentialRoot,
      tenantSlug,
      DECISION_LEDGER_LAYOUT.decisionsDir
    ),
    { allowMissingLeaf: true }
  );
}

/**
 * The case ids of a tenant: the directories under its `decisions/` whose
 * name is a case id (drafts without invites included; `_reports` and stray
 * files excluded). Sorted. Call as the tenant-bound ledger role.
 */
export function listTenantCaseIds(tenantSlug: string): string[] {
  const root = tenantDecisionsRoot(tenantSlug);
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root)
    .filter((name) => CASE_ID_PATTERN.test(name))
    .filter((name) => safeLstat(path.join(root, name)).isDirectory())
    .sort();
}

export function learningReportPath(tenantSlug: string, reportDate: string): string {
  if (!LEARNING_REPORT_DATE_PATTERN.test(reportDate))
    throw new Error('[CUSTOMER_DECISION_REPORT_DATE_INVALID] invalid report date');
  return path.join(
    tenantDecisionsRoot(tenantSlug),
    CUSTOMER_DECISION_REPORTS_DIR,
    `learning-${reportDate}.json`
  );
}

/** Write (or replace) the tenant's learning report of a date. Call as the tenant-bound ledger role. */
export function writeLearningReport(report: CustomerDecisionLearningReport): {
  path: string;
  report: CustomerDecisionLearningReport;
} {
  const validated = validate<CustomerDecisionLearningReport>('learning_report', report);
  const file = prepareWrite(learningReportPath(validated.tenant_slug, validated.report_date));
  writeJson(file, validated);
  return { path: file, report: validated };
}

const LEARNING_REPORT_FILE_PATTERN = /^learning-(\d{4}-\d{2}-\d{2})\.json$/u;

/** The dates of the tenant's learning reports, oldest first. Call as the tenant-bound ledger role. */
export function listLearningReportDates(tenantSlug: string): string[] {
  const dir = path.join(tenantDecisionsRoot(tenantSlug), CUSTOMER_DECISION_REPORTS_DIR);
  const safe = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(safe)) return [];
  return safeReaddir(safe)
    .map((name) => name.match(LEARNING_REPORT_FILE_PATTERN)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort();
}

export function readLearningReport(
  tenantSlug: string,
  reportDate: string
): CustomerDecisionLearningReport | undefined {
  const raw = readRecord(learningReportPath(tenantSlug, reportDate));
  if (raw === undefined) return undefined;
  const report = validate<CustomerDecisionLearningReport>('learning_report', raw);
  if (report.tenant_slug !== tenantSlug || report.report_date !== reportDate)
    throw new Error('[CUSTOMER_DECISION_REPORT_MISMATCH] report does not match its file');
  return report;
}
