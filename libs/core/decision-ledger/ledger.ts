/**
 * Decision ledger I/O (SD-00 §2.1). The per-tenant, per-case decision ledger:
 *
 *   knowledge/confidential/<tenant>/decisions/<case>/decisions.jsonl   append-only
 *   knowledge/confidential/<tenant>/decisions/<case>/observed.json     machine-written
 *   knowledge/confidential/<tenant>/decisions/<case>/lock.json         generated
 *   knowledge/confidential/<tenant>/decisions/<case>/report.json       generated
 *   knowledge/confidential/<tenant>/decisions/<case>/concepts/PC-*.json
 *   knowledge/confidential/<tenant>/customers/<customer>/actors.json   SD-04 registry
 *
 * All I/O goes through secure-io; the tenant slug is validated with the
 * entity-scope grammar so reserved tier names can never become a ledger. A
 * `{ dir }` location exists for hermetic tests (a uniquely named directory
 * under `pathResolver.sharedTmp()`); it is still constrained to the
 * repository root by `assertSafeRepositoryPath`.
 *
 * Every ledger write (`appendDecisions`, `applyPromotions`) runs under one
 * inter-process lock per ledger ({@link withDecisionLedgerLock}), taken inside
 * the write functions themselves so no writer — the `decisions` facade, the
 * customer-decision facade or a future one — can forget it. The lock is
 * re-entrant within a process, so a caller that must read → plan → write
 * across several calls (customer-decision `respond` pre-assigns ids) holds it
 * around the whole sequence. Lock order: a caller's own coarser lock (e.g. the
 * customer-decision case lock) first, then this one; the ledger lock never
 * takes another lock, so the order cannot invert.
 *
 * Validation on append is the same four refusals the tenant-side PoC
 * established: unknown level, missing basis on a decided record, an active
 * record for the same item/key without `supersedes`, and a `supersedes`
 * that names nothing active.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  CASE_ID_PATTERN,
  CUSTOMER_SLUG_PATTERN,
  DECISION_ID_PATTERN,
  DECISION_LEDGER_LAYOUT,
  isDecisionLevel,
  isDecisionState,
  type DecisionConformanceReport,
  type DecisionCustomerActor,
  type DecisionCustomerActorRegistry,
  type DecisionRecord,
  type DecisionLock,
  type DecisionObservedSet,
} from './model.js';
import { promoteDecision, type DecisionPromotionResult } from './promote.js';
import type { DecisionAuthorityPolicy } from './policy.js';
import type { DecisionPromotionRequest } from './hearing-scenario.js';
import type { ProductConcept } from './product-concept.js';
import type { DecisionProbeSet } from './probes.js';

export type DecisionLedgerLocation = { tenantSlug: string; caseId: string } | { dir: string };

const SCHEMAS = {
  decision: pathResolver.rootResolve('knowledge/product/schemas/decision-record.schema.json'),
  observed: pathResolver.rootResolve('knowledge/product/schemas/decision-observed.schema.json'),
  lock: pathResolver.rootResolve('knowledge/product/schemas/decision-lock.schema.json'),
  actors: pathResolver.rootResolve(
    'knowledge/product/schemas/decision-customer-actors.schema.json'
  ),
  concept: pathResolver.rootResolve('knowledge/product/schemas/product-concept.schema.json'),
  probes: pathResolver.rootResolve('knowledge/product/schemas/decision-probes.schema.json'),
};

function validate<T>(value: unknown, id: string, schemaPath: string): T {
  return defineCatalog<T>({ id, path: schemaPath, schema: schemaPath }).validate(value) as T;
}

export function isValidCaseId(value: string): boolean {
  return CASE_ID_PATTERN.test(value);
}

export function ledgerDir(location: DecisionLedgerLocation): string {
  if ('dir' in location) {
    return assertSafeRepositoryPath(location.dir, { allowMissingLeaf: true });
  }
  if (!isValidTenantSlug(location.tenantSlug))
    throw new Error('[DECISION_LEDGER_TENANT_INVALID] invalid tenant slug');
  if (!isValidCaseId(location.caseId))
    throw new Error('[DECISION_LEDGER_CASE_INVALID] invalid case id');
  return assertSafeRepositoryPath(
    path.join(
      pathResolver.rootDir(),
      DECISION_LEDGER_LAYOUT.confidentialRoot,
      location.tenantSlug,
      DECISION_LEDGER_LAYOUT.decisionsDir,
      location.caseId
    ),
    { allowMissingLeaf: true }
  );
}

export function ledgerPaths(location: DecisionLedgerLocation) {
  const dir = ledgerDir(location);
  return {
    dir,
    decisions: path.join(dir, DECISION_LEDGER_LAYOUT.files.decisions),
    observed: path.join(dir, DECISION_LEDGER_LAYOUT.files.observed),
    lock: path.join(dir, DECISION_LEDGER_LAYOUT.files.lock),
    report: path.join(dir, DECISION_LEDGER_LAYOUT.files.report),
    concepts: path.join(dir, DECISION_LEDGER_LAYOUT.conceptsDir),
    actors: path.join(dir, DECISION_LEDGER_LAYOUT.files.actors),
    probes: path.join(dir, DECISION_LEDGER_LAYOUT.files.probes),
  };
}

/** SD-06: the case's declarative probe set (`probes.json`), or `undefined` when none is declared. */
export function readProbes(location: DecisionLedgerLocation): DecisionProbeSet | undefined {
  const text = readText(ledgerPaths(location).probes);
  if (!text) return undefined;
  return validate<DecisionProbeSet>(
    parseSafeJsonInput(text, 'decision probes'),
    'decision-probes',
    SCHEMAS.probes
  );
}

export function writeProbes(
  location: DecisionLedgerLocation,
  probes: DecisionProbeSet
): DecisionProbeSet {
  const validated = validate<DecisionProbeSet>(probes, 'decision-probes', SCHEMAS.probes);
  writeText(ledgerPaths(location).probes, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export function customerActorsPath(tenantSlug: string, customer: string): string {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[DECISION_LEDGER_TENANT_INVALID] invalid tenant slug');
  if (!CUSTOMER_SLUG_PATTERN.test(customer))
    throw new Error('[DECISION_LEDGER_CUSTOMER_INVALID] invalid customer slug');
  return assertSafeRepositoryPath(
    path.join(
      pathResolver.rootDir(),
      DECISION_LEDGER_LAYOUT.confidentialRoot,
      tenantSlug,
      DECISION_LEDGER_LAYOUT.customersDir,
      customer,
      DECISION_LEDGER_LAYOUT.files.actors
    ),
    { allowMissingLeaf: true }
  );
}

function readText(file: string): string | undefined {
  const safe = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  if (!safeExistsSync(safe)) return undefined;
  return String(safeReadFile(safe, { encoding: 'utf8' }));
}

function writeText(file: string, text: string): void {
  const safe = assertSafeRepositoryPath(file, { allowMissingLeaf: true });
  safeMkdir(path.dirname(safe), { recursive: true });
  safeWriteFile(safe, text, { encoding: 'utf8' });
}

export function readLedger(location: DecisionLedgerLocation): DecisionRecord[] {
  const text = readText(ledgerPaths(location).decisions);
  if (!text) return [];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) =>
      validate<DecisionRecord>(
        parseSafeJsonInput(line, `decision record line ${index + 1}`),
        'decision-record',
        SCHEMAS.decision
      )
    );
}

export function readObserved(location: DecisionLedgerLocation): DecisionObservedSet | undefined {
  const text = readText(ledgerPaths(location).observed);
  if (!text) return undefined;
  return validate<DecisionObservedSet>(
    parseSafeJsonInput(text, 'decision observed'),
    'decision-observed',
    SCHEMAS.observed
  );
}

export function writeObserved(
  location: DecisionLedgerLocation,
  observed: DecisionObservedSet
): DecisionObservedSet {
  const validated = validate<DecisionObservedSet>(observed, 'decision-observed', SCHEMAS.observed);
  writeText(ledgerPaths(location).observed, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

export function readCustomerActors(
  location: DecisionLedgerLocation,
  customer?: string
): DecisionCustomerActor[] {
  const file =
    'dir' in location || !customer
      ? ledgerPaths(location).actors
      : customerActorsPath(location.tenantSlug, customer);
  const text = readText(file);
  if (!text) return [];
  return validate<DecisionCustomerActorRegistry>(
    parseSafeJsonInput(text, 'decision customer actors'),
    'decision-customer-actors',
    SCHEMAS.actors
  ).actors;
}

export function writeCustomerActors(
  location: DecisionLedgerLocation,
  registry: DecisionCustomerActorRegistry
): DecisionCustomerActorRegistry {
  const validated = validate<DecisionCustomerActorRegistry>(
    registry,
    'decision-customer-actors',
    SCHEMAS.actors
  );
  const file =
    'dir' in location
      ? ledgerPaths(location).actors
      : customerActorsPath(location.tenantSlug, validated.customer);
  writeText(file, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export type DecisionAppendInput = Omit<DecisionRecord, 'id' | 'status' | 'case_id'> & {
  id?: string;
  case_id?: string;
};

export function nextDecisionId(existing: readonly DecisionRecord[]): string {
  const max = existing.reduce((acc, item) => {
    const match = /^D-(\d+)$/u.exec(item.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `D-${String(max + 1).padStart(4, '0')}`;
}

/** Stable, prose-free refusal codes so the facade and the surface can render them. */
export function validateAppend(
  existing: readonly DecisionRecord[],
  incoming: DecisionAppendInput
): string[] {
  const errors: string[] = [];
  if (!incoming.item || !incoming.key) errors.push('item_and_key_required');
  if (!isDecisionLevel(incoming.level)) errors.push('level_invalid');
  if (!isDecisionState(incoming.state)) errors.push('state_invalid');
  if (incoming.state === 'decided') {
    if (!incoming.basis || incoming.basis.length === 0) errors.push('basis_required');
    if (!incoming.decided_by || incoming.decided_by.kind !== 'human')
      errors.push('decided_by_human_required');
  }
  if (incoming.id && !DECISION_ID_PATTERN.test(incoming.id)) errors.push('id_invalid');
  if (incoming.id && existing.some((item) => item.id === incoming.id)) errors.push('id_exists');
  const live = existing.filter(
    (item) => item.status === 'active' && item.item === incoming.item && item.key === incoming.key
  );
  if (live.length > 0 && !incoming.supersedes) errors.push('supersedes_required');
  if (incoming.supersedes && !live.some((item) => item.id === incoming.supersedes)) {
    errors.push('supersedes_not_active');
  }
  return errors;
}

export class DecisionLedgerError extends Error {
  constructor(
    public readonly code: string,
    public readonly details: Array<{ index: number; errors: string[] }>
  ) {
    super(
      `[DECISION_LEDGER_${code.toUpperCase()}] ${details.map((d) => `#${d.index}: ${d.errors.join(', ')}`).join('; ')}`
    );
    this.name = 'DecisionLedgerError';
  }
}

// ---------------------------------------------------------------------------
// Ledger lock (inter-process, one per ledger; re-entrant within a process)
// ---------------------------------------------------------------------------

/** Long enough to queue behind a customer respond, short of the customer room's 15 s child limit. */
export const DECISION_LEDGER_LOCK_TIMEOUT_MS = 10_000;

/** The lock resource of a ledger: tenant + case, or a hash of a test `dir`. */
export function decisionLedgerLockId(location: DecisionLedgerLocation): string {
  const dir = ledgerDir(location); // validates the tenant slug and case id
  if ('dir' in location) {
    return `decision-ledger-dir-${createHash('sha256').update(dir).digest('hex').slice(0, 24)}`;
  }
  return `decision-ledger-${location.tenantSlug}-${location.caseId}`;
}

/** Ledger locks this process holds, with their nesting depth (withLockSync is not re-entrant). */
const heldLedgerLocks = new Map<string, number>();

/**
 * Run `fn` holding the ledger's inter-process lock. Re-entrant for the same
 * ledger in this process (nested calls run inside the outer hold), so callers
 * may wrap a read → plan → write sequence around `appendDecisions`, which
 * takes it again. The lock file lives under `active/shared/runtime/locks/`
 * (security-policy default_allow).
 */
export function withDecisionLedgerLock<T>(
  location: DecisionLedgerLocation,
  fn: () => T,
  timeoutMs = DECISION_LEDGER_LOCK_TIMEOUT_MS
): T {
  const id = decisionLedgerLockId(location);
  const depth = heldLedgerLocks.get(id) ?? 0;
  if (depth > 0) {
    heldLedgerLocks.set(id, depth + 1);
    try {
      return fn();
    } finally {
      heldLedgerLocks.set(id, depth);
    }
  }
  return withLockSync(
    id,
    () => {
      heldLedgerLocks.set(id, 1);
      try {
        return fn();
      } finally {
        heldLedgerLocks.delete(id);
      }
    },
    timeoutMs
  );
}

export interface DecisionAppendResult {
  appended: DecisionRecord[];
  superseded: string[];
  dryRun: boolean;
}

export function appendDecisions(
  location: DecisionLedgerLocation,
  records: readonly DecisionAppendInput[],
  options: { dryRun?: boolean; caseId?: string } = {}
): DecisionAppendResult {
  return withDecisionLedgerLock(location, () => appendDecisionsLocked(location, records, options));
}

function appendDecisionsLocked(
  location: DecisionLedgerLocation,
  records: readonly DecisionAppendInput[],
  options: { dryRun?: boolean; caseId?: string }
): DecisionAppendResult {
  const existing = readLedger(location);
  const caseId =
    options.caseId ?? ('dir' in location ? (existing[0]?.case_id ?? 'case') : location.caseId);
  const working = [...existing];
  const appended: DecisionRecord[] = [];
  const superseded: string[] = [];
  const problems: Array<{ index: number; errors: string[] }> = [];
  records.forEach((record, index) => {
    const errors = validateAppend(working, record);
    if (errors.length) {
      problems.push({ index, errors });
      return;
    }
    const full: DecisionRecord = {
      ...record,
      id: record.id ?? nextDecisionId(working),
      case_id: record.case_id ?? caseId,
      status: 'active',
    };
    const validated = validate<DecisionRecord>(full, 'decision-record', SCHEMAS.decision);
    if (validated.supersedes) {
      for (const item of working) {
        if (item.id === validated.supersedes && item.status === 'active') {
          item.status = 'superseded';
          superseded.push(item.id);
        }
      }
    }
    working.push(validated);
    appended.push(validated);
  });
  if (problems.length) throw new DecisionLedgerError('append_rejected', problems);
  if (!options.dryRun) {
    writeText(
      ledgerPaths(location).decisions,
      working.map((item) => JSON.stringify(item)).join('\n') + (working.length ? '\n' : '')
    );
  }
  return { appended, superseded, dryRun: Boolean(options.dryRun) };
}

// ---------------------------------------------------------------------------
// Promotion through the ledger (hearing → decided / proposed)
// ---------------------------------------------------------------------------

export interface DecisionApplyPromotionsResult {
  results: Array<{
    promote: string;
    result: DecisionPromotionResult | { outcome: 'skipped'; reason: string };
  }>;
  append: DecisionAppendResult;
}

export function applyPromotions(
  location: DecisionLedgerLocation,
  requests: readonly DecisionPromotionRequest[],
  options: {
    now: string;
    dryRun?: boolean;
    customerActors?: readonly DecisionCustomerActor[];
    policy?: DecisionAuthorityPolicy;
  }
): DecisionApplyPromotionsResult {
  // Read → promote → append under one hold: the targets cannot move in between.
  return withDecisionLedgerLock(location, () => applyPromotionsLocked(location, requests, options));
}

function applyPromotionsLocked(
  location: DecisionLedgerLocation,
  requests: readonly DecisionPromotionRequest[],
  options: Parameters<typeof applyPromotions>[2]
): DecisionApplyPromotionsResult {
  const existing = readLedger(location);
  const inputs: DecisionAppendInput[] = [];
  const results: DecisionApplyPromotionsResult['results'] = [];
  for (const request of requests) {
    const target = existing.find((item) => item.id === request.promote && item.status === 'active');
    if (!target) {
      results.push({
        promote: request.promote,
        result: { outcome: 'skipped', reason: 'target_not_active' },
      });
      continue;
    }
    if (target.state === 'decided') {
      results.push({
        promote: request.promote,
        result: { outcome: 'skipped', reason: 'already_decided' },
      });
      continue;
    }
    const candidate: DecisionRecord = {
      ...target,
      id: 'D-0000',
      value: request.value,
      basis: [...(target.basis ?? []), ...request.basis],
      origin: request.origin,
      supersedes: target.id,
      ...(request.source_turn ? { source_turn: request.source_turn } : {}),
    };
    const outcome = promoteDecision({
      decision: candidate,
      decidedBy: request.decided_by,
      now: options.now,
      customerActors: options.customerActors ?? [],
      ...(options.policy ? { policy: options.policy } : {}),
    });
    results.push({ promote: request.promote, result: outcome });
    const { id: _id, case_id: _case, status: _status, ...rest } = outcome.decision;
    void _id;
    void _case;
    void _status;
    inputs.push({ ...rest, proposed_at: rest.proposed_at ?? options.now });
  }
  const append = inputs.length
    ? appendDecisions(location, inputs, { dryRun: options.dryRun })
    : { appended: [], superseded: [], dryRun: Boolean(options.dryRun) };
  return { results, append };
}

// ---------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------

export function writeConformance(
  location: DecisionLedgerLocation,
  report: DecisionConformanceReport,
  lock: DecisionLock
): void {
  const paths = ledgerPaths(location);
  const validatedLock = validate<DecisionLock>(lock, 'decision-lock', SCHEMAS.lock);
  writeText(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  writeText(paths.lock, `${JSON.stringify(validatedLock, null, 2)}\n`);
}

export function writeProductConcept(
  location: DecisionLedgerLocation,
  concept: ProductConcept
): string {
  const validated = validate<ProductConcept>(concept, 'product-concept', SCHEMAS.concept);
  const file = path.join(ledgerPaths(location).concepts, `${validated.id}.json`);
  writeText(file, `${JSON.stringify(validated, null, 2)}\n`);
  return file;
}
