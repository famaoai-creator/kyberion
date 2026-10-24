/**
 * Customer decision storage (CD-01). Everything lives under the SSOD case
 * directory, next to the decision ledger that holds the values:
 *
 *   knowledge/confidential/<tenant>/decisions/<case>/agendas/<agenda_id>.json
 *   knowledge/confidential/<tenant>/decisions/<case>/receipts/<receipt_id>.json   immutable
 *   knowledge/confidential/<tenant>/decisions/<case>/switches.jsonl               append-only
 *   knowledge/confidential/<tenant>/decisions/<case>/respond-journal/<receipt_id>.json  write-ahead, removed when done
 *
 * Every read-plan-write sequence on a case (agenda edits, approval pins, sends,
 * responses, confirmations) runs under one inter-process lock per tenant +
 * case ({@link withCustomerDecisionCaseLock}), so two concurrent responses
 * can never lose a decision, assign the same ledger id twice or both write a
 * receipt for one double submit.
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
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmSync,
} from '../secure-io.js';
import { ledgerDir, type DecisionLedgerLocation } from '../decision-ledger/ledger.js';
import {
  AGENDA_ID_PATTERN,
  CUSTOMER_DECISION_LAYOUT,
  RECEIPT_ID_PATTERN,
  type DecisionAgenda,
  type DecisionReceipt,
  type DecisionSwitch,
  type EffectiveDecision,
} from './model.js';

/** Same shape as the ledger location: a tenant + case, or a test `dir`. */
export type CustomerDecisionLocation = DecisionLedgerLocation;

const SCHEMA_FILES = {
  agenda: 'knowledge/product/schemas/customer-decision-agenda.schema.json',
  receipt: 'knowledge/product/schemas/customer-decision-receipt.schema.json',
  switch: 'knowledge/product/schemas/customer-decision-switch.schema.json',
  journal: 'knowledge/product/schemas/customer-decision-respond-journal.schema.json',
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

export function writeAgenda(
  location: CustomerDecisionLocation,
  agenda: DecisionAgenda
): DecisionAgenda {
  const validated = validate<DecisionAgenda>('agenda', agenda);
  assertBelongs(location, validated, 'agenda');
  writeJson(prepareWrite(agendaPath(location, validated.agenda_id)), validated);
  return validated;
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

/** Long enough to queue behind a respond, short of the customer room's 15 s child limit. */
export const CUSTOMER_DECISION_CASE_LOCK_TIMEOUT_MS = 10_000;

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
 * Run `fn` holding the case lock. The lock file lives under
 * `active/shared/runtime/locks/` (security-policy default_allow), so take it
 * under the caller's own identity, OUTSIDE any narrow store role, and do all
 * reads, planning and writes of the sequence inside `fn`. Not re-entrant.
 */
export function withCustomerDecisionCaseLock<T>(
  location: CustomerDecisionLocation,
  fn: () => T,
  timeoutMs = CUSTOMER_DECISION_CASE_LOCK_TIMEOUT_MS
): T {
  return withLockSync(customerDecisionCaseLockId(location), fn, timeoutMs);
}

// ---------------------------------------------------------------------------
// Respond journal (write-ahead record of one respond run)
// ---------------------------------------------------------------------------

/** The last step of a respond run known to be done. */
export type RespondJournalStage = 'planned' | 'ledger_written' | 'receipt_written' | 'audited';

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
