import { currentExecutionScope } from '../foundation/execution-scope.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { resolveRole, withExecutionContext } from '../authority.js';
/**
 * Accountability charter — persistence, acceptance and the consumption ledger.
 *
 * Layout (path seam mirrors member-registry: `rootDir` for hermetic tests):
 *   person       knowledge/personal/charters/{charter_id}.json
 *   organization knowledge/confidential/{tenant}/charters/{charter_id}.json
 *   ledger       <same dir>/{charter_id}.ledger.jsonl   (append-only)
 *
 * Only the accountable human can accept (or clear a tripwire): the acceptance
 * statement is hashed into the charter, so a later edit of the text is
 * detectable. All file I/O goes through secure-io.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { assertHumanActor, type ActorRef } from '../actor.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { listTenantProfileSlugs } from '../organization/tenant-registry.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import {
  evaluateAgainstCharter,
  isCharterActive,
  validateCharter,
  type Charter,
  type CharterAction,
  type CharterAvailability,
  type CharterDecision,
  type CharterScope,
  type CharterUsage,
  type CharterValidationContext,
} from './accountability-charter.js';

export interface CharterPathOptions {
  rootDir?: string;
}

const CHARTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export function assertCharterId(id: string): void {
  if (!CHARTER_ID_PATTERN.test(id)) throw new Error(`[charter] invalid charter id '${id}'`);
}

export function charterDir(scope: CharterScope, options: CharterPathOptions = {}): string {
  const root = options.rootDir ?? pathResolver.rootDir();
  if (scope.kind === 'person') return path.join(root, 'knowledge', 'personal', 'charters');
  if (!isValidTenantSlug(scope.tenant_slug)) {
    throw new Error(`[charter] invalid tenant slug '${scope.tenant_slug}'`);
  }
  return path.join(root, 'knowledge', 'confidential', scope.tenant_slug, 'charters');
}

export function charterPath(
  scope: CharterScope,
  charterId: string,
  options: CharterPathOptions = {}
): string {
  assertCharterId(charterId);
  return path.join(charterDir(scope, options), `${charterId}.json`);
}

function ledgerPath(scope: CharterScope, charterId: string, options: CharterPathOptions): string {
  assertCharterId(charterId);
  return path.join(charterDir(scope, options), `${charterId}.ledger.jsonl`);
}

function safePath(file: string, options: CharterPathOptions): string {
  return assertSafeRepositoryPath(file, { allowMissingLeaf: true, rootDir: options.rootDir });
}

/** Narrow, synchronous I/O mediation; caller role is preserved for decisions. */
function scopedCharterIo<T>(
  scope: CharterScope,
  files: string[],
  writes: string[],
  action: () => T
): T {
  const identity = currentExecutionScope();
  if (scope.kind !== 'organization' || !identity?.tenantSlug) return action();
  if (identity.tenantSlug !== scope.tenant_slug)
    throw new Error('[CHARTER_SCOPE_DENIED] Caller tenant differs from charter tenant');
  const relative = (file: string) => {
    const value = path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
    if (!value || value.startsWith('../') || path.isAbsolute(value))
      throw new Error('[CHARTER_SCOPE_DENIED] Charter resource outside repository');
    return value;
  };
  const role = resolveRole();
  return runInResourceAccessScope(
    {
      tenantSlug: scope.tenant_slug,
      readExact: files.map(relative),
      writeExact: writes.map(relative),
      mkdirExact: [],
    },
    () =>
      withExecutionContext(
        role,
        action,
        'ecosystem_architect',
        scope.tenant_slug,
        identity.organizationId
      )
  );
}

export function readCharter(
  scope: CharterScope,
  charterId: string,
  options: CharterPathOptions = {}
): Charter | null {
  return scopedCharterIo(scope, [charterPath(scope, charterId, options)], [], () => {
    const file = safePath(charterPath(scope, charterId, options), options);
    if (!safeExistsSync(file)) return null;
    const parsed = parseSafeJsonInput(readTextFile(file), `charter '${charterId}'`) as Charter;
    if (parsed?.charter_id !== charterId) {
      throw new Error(`[charter] file '${file}' declares charter_id '${parsed?.charter_id}'`);
    }
    if (
      parsed.scope?.kind !== scope.kind ||
      (scope.kind === 'organization' &&
        (parsed.scope.kind !== 'organization' || parsed.scope.tenant_slug !== scope.tenant_slug))
    )
      throw new Error(
        '[CHARTER_SCOPE_DENIED] Persisted charter scope differs from requested resource'
      );
    return parsed;
  });
}

export function listCharterIds(scope: CharterScope, options: CharterPathOptions = {}): string[] {
  return scopedCharterIo(scope, [charterDir(scope, options)], [], () => {
    let dir: string;
    try {
      dir = safePath(charterDir(scope, options), options);
    } catch {
      return [];
    }
    if (!safeExistsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => CHARTER_ID_PATTERN.test(id))
      .sort();
  });
}

/** The one in-force charter for a scope, or null (=> the legacy approval gate applies). */
export function findActiveCharter(
  scope: CharterScope,
  now: Date,
  options: CharterPathOptions = {}
): Charter | null {
  const active = listCharterIds(scope, options)
    .map((id) => readCharter(scope, id, options))
    .filter(
      (c): c is Charter => c !== null && isCharterActive(c, now) && !isCharterRetired(c, options)
    );
  if (active.length > 1) {
    throw new Error(
      `[charter] scope has ${active.length} active charters; exactly one may be in force`
    );
  }
  return active[0] ?? null;
}

/** Every charter currently in force: the person's own, plus one per registered tenant. */
export function listActiveCharters(now: Date, options: CharterPathOptions = {}): Charter[] {
  const scopes: CharterScope[] = [
    { kind: 'person' },
    ...listTenantProfileSlugs(options).map(
      (tenant_slug) => ({ kind: 'organization', tenant_slug }) as const
    ),
  ];
  const out: Charter[] = [];
  for (const scope of scopes) {
    let active: Charter | null = null;
    try {
      active = findActiveCharter(scope, now, options);
    } catch {
      // A scope with two active charters is reported by the caller's own
      // validation; one bad scope must not hide every other scope's report.
      continue;
    }
    if (active) out.push(active);
  }
  return out;
}

export interface AcceptCharterInput {
  /** Draft: accepted_at / statement_sha256 are filled here. */
  draft: Omit<Charter, 'accountable'> & {
    accountable: Omit<Charter['accountable'], 'accepted_at' | 'statement_sha256'>;
  };
  /** The exact acceptance text the human saw. Its hash is stored in the charter. */
  statement: string;
  /** Must be the authenticated accountable human. */
  acceptedBy: ActorRef;
  /**
   * Charter id in force for this scope that this one replaces (amendments are
   * new charters). Required when the scope already has an active charter; the
   * old one is retired, never edited.
   */
  replaces?: string;
  validation: Omit<CharterValidationContext, 'now'>;
  now?: Date;
}

/**
 * Validate and persist a charter. Refuses unless the accepting actor is the
 * human named as accountable — nobody can accept responsibility for someone
 * else, and an agent can never accept.
 */
export function acceptCharter(
  input: AcceptCharterInput,
  options: CharterPathOptions = {}
): Charter {
  assertHumanActor(input.acceptedBy, 'accept charter');
  if (input.acceptedBy.id !== input.draft.accountable.actor) {
    throw new Error(
      `[charter] only the accountable human can accept (accepting=${input.acceptedBy.id}, accountable=${input.draft.accountable.actor})`
    );
  }
  if (!input.statement.trim()) throw new Error('[charter] acceptance statement must not be empty');
  const now = input.now ?? new Date();
  const charter: Charter = {
    ...input.draft,
    accountable: {
      ...input.draft.accountable,
      accepted_at: now.toISOString(),
      statement_sha256: createHash('sha256').update(input.statement, 'utf8').digest('hex'),
    },
  };
  const violations = validateCharter(charter, { ...input.validation, now });
  if (violations.length > 0) {
    throw new Error(`[charter] invalid charter:\n- ${violations.join('\n- ')}`);
  }
  const file = safePath(charterPath(charter.scope, charter.charter_id, options), options);
  if (safeExistsSync(file)) {
    throw new Error(
      `[charter] '${charter.charter_id}' already exists; amendments are new charters (never edited in place)`
    );
  }
  const inForce = findActiveCharter(charter.scope, now, options);
  if (inForce) {
    if (input.replaces !== inForce.charter_id) {
      throw new Error(
        `[charter] scope already has active charter '${inForce.charter_id}'; pass replaces to amend it`
      );
    }
    // Retire the old charter first: if writing the new one then fails the scope
    // falls back to the legacy approval gate (safe), never to two charters.
    retireCharter(inForce, input.acceptedBy, `replaced by ${charter.charter_id}`, options, now);
  } else if (input.replaces) {
    throw new Error(`[charter] '${input.replaces}' is not an active charter of this scope`);
  }
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(charter, null, 2) + '\n', { encoding: 'utf8' });
  return charter;
}

export function isCharterRetired(charter: Charter, options: CharterPathOptions = {}): boolean {
  return readLedger(charter.scope, charter.charter_id, options).some((e) => e.kind === 'retired');
}

/**
 * Retire a charter (append-only; the file is kept for the record). Only the
 * accountable human or a named deputy can do it. The scope falls back to the
 * legacy approval gate until a new charter is accepted.
 */
export function retireCharter(
  charter: Charter,
  retiredBy: ActorRef,
  reason: string,
  options: CharterPathOptions = {},
  now: Date = new Date()
): void {
  assertHumanActor(retiredBy, 'retire charter');
  if (![charter.accountable.actor, ...charter.accountable.deputies].includes(retiredBy.id)) {
    throw new Error(`[charter] '${retiredBy.id}' cannot retire ${charter.charter_id}`);
  }
  appendLedger(
    charter.scope,
    charter.charter_id,
    { kind: 'retired', ts: now.toISOString(), retired_by: retiredBy.id, reason },
    options
  );
}

// ---------------------------------------------------------------------------
// Ledger (append-only) — consumption and tripwires
// ---------------------------------------------------------------------------

export type LedgerEntry =
  | {
      kind: 'delegated_execution';
      ts: string;
      permit_id: string;
      binding_hash: string;
      charter_sha256: string;
      mapping_sha256: string;
      expires_at: string;
      state: 'issued' | 'executing' | 'succeeded' | 'unknown';
      operation_id: string;
      actor_id: string;
      actor_role?: string;
      source: {
        organizationId?: string;
        projectId?: string;
        missionId?: string;
        taskId?: string;
        workItemId?: string;
      };
      step_id: string;
      correlation_id: string;
      decision_type: string;
    }
  | {
      kind: 'reservation_release';
      ts: string;
      correlation_id: string;
      consumption_ts: string;
      money: number;
      evidence_ref: string;
      resolution: 'not_executed' | 'compensated';
    }
  | {
      kind: 'execution_started';
      ts: string;
      actor: string;
      action_class: string;
      operation_id: string;
      correlation_id: string;
      effect_hash: string;
    }
  | {
      kind: 'execution_outcome';
      ts: string;
      actor: string;
      action_class: string;
      operation_id: string;
      correlation_id: string;
      effect_hash: string;
      outcome: 'succeeded' | 'failed' | 'unknown';
    }
  | {
      kind: 'consumption';
      ts: string;
      actor: string;
      on_behalf_of?: string;
      action_class: string;
      money: number;
      loss: number;
      decision: string;
      /** Idempotency key: a retried gate call with the same key never double-counts. */
      correlation_id?: string;
    }
  | {
      kind: 'denied';
      ts: string;
      actor: string;
      on_behalf_of?: string;
      action_class: string;
      reasons: string[];
      /**
       * The recipient/processor facts the action carried, so the report can
       * group information-flow denials by purpose/recipient without parsing
       * reason strings. Absent when the action had no facts at all.
       */
      information_flow?: {
        purpose: string;
        recipient_class?: string;
        processor_id?: string;
        categories: string[];
      };
      /** Which charter field the agent asks to widen, when the denial has an amendment. */
      amendment_field?: string;
      /** The limit in force and the value the denied action needed, so a proposal needs no re-evaluation. */
      amendment_current?: unknown;
      amendment_requested?: unknown;
      correlation_id?: string;
    }
  | { kind: 'tripwire'; ts: string; tripwire: string; detail?: string }
  | { kind: 'tripwire_clear'; ts: string; tripwire: string; cleared_by: string }
  | { kind: 'retired'; ts: string; retired_by: string; reason: string };

function appendLedger(
  scope: CharterScope,
  charterId: string,
  entry: LedgerEntry,
  options: CharterPathOptions
): void {
  const file = ledgerPath(scope, charterId, options);
  const append = () => {
    const safeFile = safePath(file, options);
    safeMkdir(path.dirname(safeFile), { recursive: true });
    appendJsonLine(safeFile, entry);
  };
  if (
    entry.kind === 'consumption' ||
    entry.kind === 'delegated_execution' ||
    entry.kind === 'denied'
  ) {
    // Only an existing validated charter grants an exact ledger append capability.
    if (!readCharter(scope, charterId, options))
      throw new Error('[CHARTER_SCOPE_DENIED] Existing charter required');
    return scopedCharterIo(scope, [file], [file], () =>
      appendJsonLine(safePath(file, options), entry)
    );
  }
  append();
}

/** Runtime-owned delegated execution records share the charter's audit ledger. */
export function appendDelegatedExecutionRecord(
  charter: Charter,
  entry: Extract<LedgerEntry, { kind: 'delegated_execution' }>,
  options: CharterPathOptions = {}
): void {
  appendLedger(charter.scope, charter.charter_id, entry, options);
}

/** Execution evidence is distinct from admission/budget consumption. */
export function recordCharterExecutionOutcome(
  charter: Charter,
  evidence: Omit<Extract<LedgerEntry, { kind: 'execution_outcome' }>, 'kind' | 'ts'>,
  options: CharterPathOptions = {},
  now: Date = new Date()
): boolean {
  return withCharterDecisionLock(charter.scope, () => {
    const entries = readLedger(charter.scope, charter.charter_id, options);
    // An arbitrary charter object is never proof that this operation was admitted.
    if (
      !entries.some(
        (e) =>
          e.kind === 'consumption' &&
          e.correlation_id === evidence.correlation_id &&
          e.action_class === evidence.action_class &&
          e.actor === evidence.actor
      )
    )
      return false;
    const started = entries.find(
      (e) => e.kind === 'execution_started' && e.correlation_id === evidence.correlation_id
    );
    if (
      started?.kind === 'execution_started' &&
      (started.effect_hash !== evidence.effect_hash ||
        started.operation_id !== evidence.operation_id ||
        started.actor !== evidence.actor ||
        started.action_class !== evidence.action_class)
    )
      return false;
    const previous = entries
      .filter(
        (e): e is Extract<LedgerEntry, { kind: 'execution_outcome' }> =>
          e.kind === 'execution_outcome' && e.correlation_id === evidence.correlation_id
      )
      .at(-1);
    // Reconciliation appends verified evidence; it never re-executes the effect.
    if (
      previous &&
      (previous.outcome !== 'unknown' ||
        evidence.outcome === 'unknown' ||
        previous.effect_hash !== evidence.effect_hash ||
        previous.operation_id !== evidence.operation_id ||
        previous.actor !== evidence.actor ||
        previous.action_class !== evidence.action_class)
    )
      return false;
    appendLedger(
      charter.scope,
      charter.charter_id,
      {
        kind: 'execution_outcome',
        ts: now.toISOString(),
        ...evidence,
      },
      options
    );
    if (
      evidence.outcome === 'failed' &&
      charter.appetite.tripwires.includes('external_operation_failure')
    ) {
      recordTripwire(charter, 'external_operation_failure', evidence.operation_id, options, now);
    }
    return true;
  });
}

/** Fail-closed pre-effect evidence, bound to an existing scoped admission. */
export function recordCharterExecutionStarted(
  charter: Charter,
  evidence: Omit<Extract<LedgerEntry, { kind: 'execution_started' }>, 'kind' | 'ts'>,
  options: CharterPathOptions = {},
  now: Date = new Date()
): void {
  withCharterDecisionLock(charter.scope, () => {
    const entries = readLedger(charter.scope, charter.charter_id, options);
    if (
      !entries.some(
        (e) =>
          e.kind === 'consumption' &&
          e.correlation_id === evidence.correlation_id &&
          e.action_class === evidence.action_class &&
          e.actor === evidence.actor
      )
    ) {
      throw new Error(
        '[EXTERNAL_ADMISSION_MISSING] Execution start requires scoped charter consumption'
      );
    }
    if (
      entries.some(
        (e) => e.kind === 'execution_started' && e.correlation_id === evidence.correlation_id
      )
    ) {
      throw new Error('[EXTERNAL_EXECUTION_ALREADY_STARTED] Verify the earlier effect');
    }
    appendLedger(
      charter.scope,
      charter.charter_id,
      { kind: 'execution_started', ts: now.toISOString(), ...evidence },
      options
    );
  });
}

export function readCharterLedger(
  charter: Charter,
  options: CharterPathOptions = {}
): LedgerEntry[] {
  return readLedger(charter.scope, charter.charter_id, options);
}

function readLedger(
  scope: CharterScope,
  charterId: string,
  options: CharterPathOptions
): LedgerEntry[] {
  return scopedCharterIo(scope, [ledgerPath(scope, charterId, options)], [], () => {
    const file = safePath(ledgerPath(scope, charterId, options), options);
    // A malformed ledger line throws: usage must never be silently under-counted.
    return readJsonLines<LedgerEntry>(file);
  });
}

export function recordTripwire(
  charter: Charter,
  tripwire: string,
  detail: string | undefined,
  options: CharterPathOptions = {},
  now: Date = new Date()
): void {
  if (!charter.appetite.tripwires.includes(tripwire)) {
    throw new Error(`[charter] '${tripwire}' is not a declared tripwire of ${charter.charter_id}`);
  }
  appendLedger(
    charter.scope,
    charter.charter_id,
    { kind: 'tripwire', ts: now.toISOString(), tripwire, ...(detail ? { detail } : {}) },
    options
  );
}

/** Only the accountable human (or a named deputy) can lift a stop. */
export function clearTripwire(
  charter: Charter,
  tripwire: string,
  clearedBy: ActorRef,
  options: CharterPathOptions = {},
  now: Date = new Date()
): void {
  assertHumanActor(clearedBy, 'clear tripwire');
  if (![charter.accountable.actor, ...charter.accountable.deputies].includes(clearedBy.id)) {
    throw new Error(`[charter] '${clearedBy.id}' cannot clear tripwires of ${charter.charter_id}`);
  }
  appendLedger(
    charter.scope,
    charter.charter_id,
    { kind: 'tripwire_clear', ts: now.toISOString(), tripwire, cleared_by: clearedBy.id },
    options
  );
}

/** Usage over UTC calendar day / month, and the tripwires currently standing. */
export function loadCharterUsage(
  charter: Charter,
  now: Date,
  options: CharterPathOptions = {}
): CharterUsage {
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  let spentToday = 0;
  let spentMonth = 0;
  const standing = new Set<string>();
  for (const e of readLedger(charter.scope, charter.charter_id, options)) {
    if (e.kind === 'consumption') {
      if (e.ts.startsWith(month)) spentMonth += e.money;
      if (e.ts.startsWith(day)) spentToday += e.money;
    } else if (e.kind === 'reservation_release') {
      // Release the reservation in its original budget window, never credit
      // today's budget for a charge reserved in a previous day/month.
      if (e.consumption_ts.startsWith(month)) spentMonth -= e.money;
      if (e.consumption_ts.startsWith(day)) spentToday -= e.money;
    } else if (e.kind === 'tripwire') standing.add(e.tripwire);
    else if (e.kind === 'tripwire_clear') standing.delete(e.tripwire);
  }
  return {
    spent_today: spentToday,
    spent_this_month: spentMonth,
    tripwires_hit: [...standing],
  };
}

/** Provider adapters call this only after authoritative full non-execution/refund evidence. */
export function releaseCharterPaymentReservation(
  charter: Charter,
  correlationId: string,
  evidence: { resolution: 'not_executed' | 'compensated'; evidence_ref: string },
  options: CharterPathOptions = {},
  now: Date = new Date()
): boolean {
  if (!evidence.evidence_ref.trim()) throw new Error('[charter] payment evidence is required');
  return withCharterDecisionLock(charter.scope, () => {
    const entries = readLedger(charter.scope, charter.charter_id, options);
    if (
      entries.some((e) => e.kind === 'reservation_release' && e.correlation_id === correlationId)
    ) {
      return false;
    }
    const reservation = entries.find(
      (e) =>
        e.kind === 'consumption' &&
        e.action_class === 'payment' &&
        e.correlation_id === correlationId
    );
    if (!reservation || reservation.kind !== 'consumption') return false;
    appendLedger(
      charter.scope,
      charter.charter_id,
      {
        kind: 'reservation_release',
        ts: now.toISOString(),
        correlation_id: correlationId,
        consumption_ts: reservation.ts,
        money: reservation.money,
        ...evidence,
      },
      options
    );
    return true;
  });
}

/**
 * Evaluate without recording anything. Returns null when the scope has no
 * active charter (caller falls back to the legacy approval gate). Recording is
 * a separate step so a caller that ends up NOT auto-allowing (e.g. a hardened
 * policy still needs a human) never consumes budget or double-counts a retry.
 */
export function evaluateUnderCharter(
  scope: CharterScope,
  action: CharterAction,
  availability: CharterAvailability,
  options: CharterPathOptions = {},
  now: Date = new Date()
): { charter: Charter; decision: CharterDecision } | null {
  const charter = findActiveCharter(scope, now, options);
  if (!charter) return null;
  const decision = evaluateAgainstCharter({
    charter,
    action,
    usage: loadCharterUsage(charter, now, options),
    availability,
    now,
  });
  return { charter, decision };
}

function alreadyRecorded(
  entries: LedgerEntry[],
  kind: 'consumption' | 'denied',
  actionClass: string,
  correlationId: string | undefined
): boolean {
  if (!correlationId) return false;
  return entries.some(
    (e) => e.kind === kind && e.correlation_id === correlationId && e.action_class === actionClass
  );
}

/** Append the consumption of an allowed action. Idempotent per (correlation id, action class). */
export function recordCharterConsumption(
  charter: Charter,
  action: CharterAction,
  decision: CharterDecision,
  options: CharterPathOptions = {},
  now: Date = new Date(),
  correlationId?: string
): boolean {
  if (decision.decision !== 'allow' && decision.decision !== 'allow_notify') return false;
  const entries = readLedger(charter.scope, charter.charter_id, options);
  if (alreadyRecorded(entries, 'consumption', action.action_class, correlationId)) return false;
  appendLedger(
    charter.scope,
    charter.charter_id,
    {
      kind: 'consumption',
      ts: now.toISOString(),
      actor: action.actor.id,
      ...(action.actor.on_behalf_of ? { on_behalf_of: action.actor.on_behalf_of } : {}),
      action_class: action.action_class,
      money: decision.consumption.money,
      loss: decision.consumption.loss,
      decision: decision.decision,
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
    options
  );
  return true;
}

/** Append a denial (what the accountable human will see as "outside my charter"). Idempotent like consumption. */
export function recordCharterDenial(
  charter: Charter,
  action: CharterAction,
  decision: CharterDecision,
  options: CharterPathOptions = {},
  now: Date = new Date(),
  correlationId?: string
): boolean {
  if (decision.decision !== 'deny') return false;
  const entries = readLedger(charter.scope, charter.charter_id, options);
  if (alreadyRecorded(entries, 'denied', action.action_class, correlationId)) return false;
  appendLedger(
    charter.scope,
    charter.charter_id,
    {
      kind: 'denied',
      ts: now.toISOString(),
      actor: action.actor.id,
      ...(action.actor.on_behalf_of ? { on_behalf_of: action.actor.on_behalf_of } : {}),
      action_class: action.action_class,
      reasons: decision.reasons,
      ...(action.information_flow
        ? {
            information_flow: {
              purpose: action.information_flow.purpose,
              ...(action.information_flow.recipient_class
                ? { recipient_class: action.information_flow.recipient_class }
                : {}),
              ...(action.information_flow.processor_id
                ? { processor_id: action.information_flow.processor_id }
                : {}),
              categories: [...action.information_flow.categories],
            },
          }
        : {}),
      ...(decision.amendment
        ? {
            amendment_field: decision.amendment.field,
            amendment_current: decision.amendment.current,
            amendment_requested: decision.amendment.requested,
          }
        : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
    options
  );
  return true;
}

/**
 * One inter-process critical section per charter scope for read-check-append.
 *
 * The budget limits are enforced against usage read from the append-only
 * ledger, so "read usage → decide → append consumption" must be atomic or two
 * concurrent decisions both see the same remaining budget and both spend it.
 * The lock is the same primitive the other governed stores use; it is held for
 * the (short) synchronous decision, never across an external effect.
 */
export function withCharterDecisionLock<T>(scope: CharterScope, fn: () => T, timeoutMs = 5000): T {
  const key =
    scope.kind === 'organization'
      ? `charter-decision:organization:${scope.tenant_slug}`
      : 'charter-decision:person';
  return withLockSync(key, fn, timeoutMs);
}

/**
 * Convenience entry point: evaluate and, when inside the charter, record the
 * consumption atomically. Returns null when the scope has no active charter.
 */
export function decideUnderCharter(
  scope: CharterScope,
  action: CharterAction,
  availability: CharterAvailability,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterDecision | null {
  return withCharterDecisionLock(scope, () => {
    const evaluated = evaluateUnderCharter(scope, action, availability, options, now);
    if (!evaluated) return null;
    recordCharterConsumption(evaluated.charter, action, evaluated.decision, options, now);
    return evaluated.decision;
  });
}
