/**
 * Customer decision storage (CD-01). Everything lives under the SSOD case
 * directory, next to the decision ledger that holds the values:
 *
 *   knowledge/confidential/<tenant>/decisions/<case>/agendas/<agenda_id>.json
 *   knowledge/confidential/<tenant>/decisions/<case>/receipts/<receipt_id>.json   immutable
 *   knowledge/confidential/<tenant>/decisions/<case>/switches.jsonl               append-only
 *
 * Nothing goes under `system/`. All I/O goes through secure-io, every record is
 * schema-validated on write and on read, and the location reuses the ledger's
 * `ledgerDir` (tenant slug + case id validation, `{ dir }` for hermetic tests).
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { logger } from '../core.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import { ledgerDir, type DecisionLedgerLocation } from '../decision-ledger/ledger.js';
import {
  AGENDA_ID_PATTERN,
  CUSTOMER_DECISION_LAYOUT,
  RECEIPT_ID_PATTERN,
  type DecisionAgenda,
  type DecisionReceipt,
  type DecisionSwitch,
} from './model.js';

/** Same shape as the ledger location: a tenant + case, or a test `dir`. */
export type CustomerDecisionLocation = DecisionLedgerLocation;

const SCHEMA_FILES = {
  agenda: 'knowledge/product/schemas/customer-decision-agenda.schema.json',
  receipt: 'knowledge/product/schemas/customer-decision-receipt.schema.json',
  switch: 'knowledge/product/schemas/customer-decision-switch.schema.json',
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
