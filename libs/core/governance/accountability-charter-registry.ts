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

export function readCharter(
  scope: CharterScope,
  charterId: string,
  options: CharterPathOptions = {}
): Charter | null {
  const file = safePath(charterPath(scope, charterId, options), options);
  if (!safeExistsSync(file)) return null;
  const parsed = parseSafeJsonInput(readTextFile(file), `charter '${charterId}'`) as Charter;
  if (parsed?.charter_id !== charterId) {
    throw new Error(`[charter] file '${file}' declares charter_id '${parsed?.charter_id}'`);
  }
  return parsed;
}

export function listCharterIds(scope: CharterScope, options: CharterPathOptions = {}): string[] {
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
      /** Which charter field the agent asks to widen, when the denial has an amendment. */
      amendment_field?: string;
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
  const file = safePath(ledgerPath(scope, charterId, options), options);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, entry);
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
  const file = safePath(ledgerPath(scope, charterId, options), options);
  // A malformed ledger line throws: usage must never be silently under-counted.
  return readJsonLines<LedgerEntry>(file);
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
    } else if (e.kind === 'tripwire') standing.add(e.tripwire);
    else if (e.kind === 'tripwire_clear') standing.delete(e.tripwire);
  }
  return {
    spent_today: spentToday,
    spent_this_month: spentMonth,
    tripwires_hit: [...standing],
  };
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
      ...(decision.amendment ? { amendment_field: decision.amendment.field } : {}),
      ...(correlationId ? { correlation_id: correlationId } : {}),
    },
    options
  );
  return true;
}

/**
 * Convenience entry point: evaluate and, when inside the charter, record the
 * consumption. Returns null when the scope has no active charter.
 */
export function decideUnderCharter(
  scope: CharterScope,
  action: CharterAction,
  availability: CharterAvailability,
  options: CharterPathOptions = {},
  now: Date = new Date()
): CharterDecision | null {
  const evaluated = evaluateUnderCharter(scope, action, availability, options, now);
  if (!evaluated) return null;
  recordCharterConsumption(evaluated.charter, action, evaluated.decision, options, now);
  return evaluated.decision;
}
