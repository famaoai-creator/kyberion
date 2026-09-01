/**
 * DA-03 incremental-sync watermark store.
 *
 * One JSON state file per tenant × source system at
 * active/shared/runtime/ingest-cursors/{tenant}/{source_system}.json
 * (base directory overridable for hermetic tests — the `cursorsDir` seam).
 *
 * Fail-closed watermark semantics:
 *   - `advanceSyncCursor` is WRITE-AFTER-SUCCESS ONLY: callers may invoke it
 *     only after the full differential fetch completed. A partial fetch must
 *     call `recordSyncFailure` instead, which increments consecutive_failures
 *     and touches last_synced_at but NEVER moves cursor_value/last_success_at
 *     — re-running re-fetches the same window (at-least-once; the downstream
 *     ingest dedup registry absorbs re-deliveries).
 *   - A corrupt or shape-invalid state file THROWS instead of being treated
 *     as "no cursor": silently restarting from zero would look like success
 *     while hiding state loss. Operators recover with `resetSyncCursor`.
 *
 * Writes go through secure-io `safeWriteFile`, which is atomic (write to a
 * temp file, then rename) — a crashed writer can never leave a torn cursor.
 */

import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { isValidTenantSlug } from './entity-scope.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlink,
  safeWriteFile,
} from './secure-io.js';

/** Default repo-relative base directory for cursor state files. */
export const DEFAULT_INGEST_CURSORS_DIR = 'active/shared/runtime/ingest-cursors';

const SOURCE_SYSTEM_RE = /^[a-z][a-z0-9_-]{0,40}$/;

export const SYNC_CURSOR_KINDS = ['marker', 'updated_since', 'delta_token', 'etag_map'] as const;
export type SyncCursorKind = (typeof SYNC_CURSOR_KINDS)[number];

/** Persisted watermark state for one tenant × source system. */
export interface SyncCursorState {
  tenant_slug: string;
  source_system: string;
  cursor_kind: SyncCursorKind;
  /** Opaque watermark: pagination marker / ISO or Slack-ts timestamp / delta token / per-item etag map. */
  cursor_value: string | Record<string, string>;
  /** Last sync ATTEMPT (success or failure). */
  last_synced_at: string;
  /** Last fully-successful sync; '' until the first success. */
  last_success_at: string;
  /** Failures since the last success; reset to 0 by advanceSyncCursor. */
  consecutive_failures: number;
  note?: string;
}

/** Path seam for hermetic tests: override rootDir or the whole cursors base dir. */
export interface SyncCursorPathOptions {
  rootDir?: string;
  /** Absolute (or repo-relative) directory replacing DEFAULT_INGEST_CURSORS_DIR. */
  cursorsDir?: string;
}

function assertTenantSlug(slug: string): void {
  if (!isValidTenantSlug(slug)) {
    throw new Error(`[ingest-sync-cursors] invalid tenant slug '${slug}'`);
  }
}

function assertSourceSystem(sourceSystem: string): void {
  if (!SOURCE_SYSTEM_RE.test(sourceSystem)) {
    throw new Error(`[ingest-sync-cursors] invalid source_system '${sourceSystem}'`);
  }
}

function cursorsBaseDir(options: SyncCursorPathOptions): string {
  const candidate = options.cursorsDir
    ? path.isAbsolute(options.cursorsDir)
      ? options.cursorsDir
      : path.join(options.rootDir ?? pathResolver.rootDir(), options.cursorsDir)
    : path.join(options.rootDir ?? pathResolver.rootDir(), DEFAULT_INGEST_CURSORS_DIR);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

/** Absolute path of the cursor state file for a tenant × source system. */
export function syncCursorPath(
  tenantSlug: string,
  sourceSystem: string,
  options: SyncCursorPathOptions = {}
): string {
  assertTenantSlug(tenantSlug);
  assertSourceSystem(sourceSystem);
  return assertSafeRepositoryPath(
    path.join(cursorsBaseDir(options), tenantSlug, `${sourceSystem}.json`),
    { allowMissingLeaf: true }
  );
}

function isCursorValue(value: unknown): value is string | Record<string, string> {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === 'string'
  );
}

function assertCursorState(
  state: unknown,
  file: string,
  expectedTenantSlug?: string,
  expectedSourceSystem?: string
): asserts state is SyncCursorState {
  const problems: string[] = [];
  if (!isRecord(state)) {
    throw new Error(`[ingest-sync-cursors] ${file}: state must be an object`);
  }
  const tenantSlug = typeof state.tenant_slug === 'string' ? state.tenant_slug : '';
  const sourceSystem = typeof state.source_system === 'string' ? state.source_system : '';
  if (!isValidTenantSlug(tenantSlug)) problems.push('tenant_slug invalid');
  if (!SOURCE_SYSTEM_RE.test(sourceSystem)) {
    problems.push('source_system invalid');
  }
  if (expectedTenantSlug !== undefined && tenantSlug !== expectedTenantSlug) {
    problems.push('tenant_slug does not match the requested tenant');
  }
  if (expectedSourceSystem !== undefined && sourceSystem !== expectedSourceSystem) {
    problems.push('source_system does not match the requested source');
  }
  if (!SYNC_CURSOR_KINDS.includes(state.cursor_kind as SyncCursorKind)) {
    problems.push(`cursor_kind must be one of ${SYNC_CURSOR_KINDS.join('|')}`);
  }
  if (!isCursorValue(state.cursor_value)) {
    problems.push('cursor_value must be a string or a string map');
  }
  if (
    typeof state.last_synced_at !== 'string' ||
    !Number.isFinite(Date.parse(state.last_synced_at))
  ) {
    problems.push('last_synced_at must be a valid timestamp');
  }
  if (
    typeof state.last_success_at !== 'string' ||
    (state.last_success_at !== '' && !Number.isFinite(Date.parse(state.last_success_at)))
  ) {
    problems.push('last_success_at must be empty or a valid timestamp');
  }
  if (
    typeof state.consecutive_failures !== 'number' ||
    !Number.isInteger(state.consecutive_failures) ||
    state.consecutive_failures < 0
  ) {
    problems.push('consecutive_failures must be a non-negative integer');
  }
  if (state.note !== undefined && typeof state.note !== 'string') {
    problems.push('note must be a string');
  }
  if (problems.length > 0) {
    throw new Error(
      `[ingest-sync-cursors] invalid cursor state at ${file}: ${problems.join('; ')}. ` +
        'Fail-closed: fix or resetSyncCursor — the watermark is never silently discarded.'
    );
  }
}

/**
 * Reads the cursor state. Returns null when no state file exists (first
 * sync). Throws on an unreadable file, corrupt JSON, or invalid shape
 * (fail-closed — see module header).
 */
export function readSyncCursor(
  tenantSlug: string,
  sourceSystem: string,
  options: SyncCursorPathOptions = {}
): SyncCursorState | null {
  const file = syncCursorPath(tenantSlug, sourceSystem, options);
  if (!safeExistsSync(file)) return null;
  // Read failures must not be reported as corrupt JSON: cursors live under a
  // tenant-scoped prefix, so a refused read is an authorization problem, and
  // the "resetSyncCursor" remedy below would discard a perfectly good watermark
  // and force a full re-fetch to fix something it cannot fix.
  let source: string;
  try {
    source = String(safeReadFile(file, { encoding: 'utf8' }));
  } catch (error) {
    throw new Error(
      `[ingest-sync-cursors] cursor state at ${file} could not be read: ${String(
        (error as Error)?.message ?? error
      ).replace(
        /\s*\.\s*$/,
        ''
      )}. Fail-closed: the watermark is intact — resolve access before re-running the sync.`
    );
  }
  let state: unknown;
  try {
    state = parseSafeJsonInput(source, `ingest sync cursor state at ${file}`);
  } catch (error) {
    throw new Error(
      `[ingest-sync-cursors] cursor state at ${file} is not valid JSON: ${(error as Error).message}. ` +
        'Fail-closed: resetSyncCursor to restart from a full re-fetch.'
    );
  }
  assertCursorState(state, file, tenantSlug, sourceSystem);
  return state;
}

function writeCursorState(
  tenantSlug: string,
  sourceSystem: string,
  state: SyncCursorState,
  options: SyncCursorPathOptions
): SyncCursorState {
  const file = syncCursorPath(tenantSlug, sourceSystem, options);
  assertCursorState(state, file);
  safeMkdir(path.dirname(file), { recursive: true });
  // safeWriteFile is atomic (temp file + rename) — no torn cursor on crash.
  safeWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export interface SyncCursorAdvance {
  cursor_kind: SyncCursorKind;
  cursor_value: string | Record<string, string>;
  /** Timestamp override for deterministic tests; default: wall clock. */
  now?: string;
  note?: string;
}

/**
 * WRITE-AFTER-SUCCESS ONLY: persists the new watermark after a FULLY
 * successful differential fetch. Resets consecutive_failures and stamps
 * last_success_at = last_synced_at = now.
 */
export function advanceSyncCursor(
  tenantSlug: string,
  sourceSystem: string,
  advance: SyncCursorAdvance,
  options: SyncCursorPathOptions = {}
): SyncCursorState {
  const now = advance.now ?? new Date().toISOString();
  const previous = readSyncCursor(tenantSlug, sourceSystem, options);
  const state: SyncCursorState = {
    tenant_slug: tenantSlug,
    source_system: sourceSystem,
    cursor_kind: advance.cursor_kind,
    cursor_value: advance.cursor_value,
    last_synced_at: now,
    last_success_at: now,
    consecutive_failures: 0,
    ...(advance.note !== undefined
      ? { note: advance.note }
      : previous?.note !== undefined
        ? { note: previous.note }
        : {}),
  };
  return writeCursorState(tenantSlug, sourceSystem, state, options);
}

export interface SyncCursorFailure {
  /** Only used when no prior state exists (first sync failed). Default 'marker'. */
  cursor_kind?: SyncCursorKind;
  /** Timestamp override for deterministic tests; default: wall clock. */
  now?: string;
  note?: string;
}

/**
 * Records a failed sync attempt: increments consecutive_failures and stamps
 * last_synced_at WITHOUT advancing cursor_value or last_success_at — the
 * next run re-fetches the same window (at-least-once).
 */
export function recordSyncFailure(
  tenantSlug: string,
  sourceSystem: string,
  failure: SyncCursorFailure = {},
  options: SyncCursorPathOptions = {}
): SyncCursorState {
  const now = failure.now ?? new Date().toISOString();
  const previous = readSyncCursor(tenantSlug, sourceSystem, options);
  const state: SyncCursorState = previous
    ? {
        ...previous,
        last_synced_at: now,
        consecutive_failures: previous.consecutive_failures + 1,
        ...(failure.note !== undefined ? { note: failure.note } : {}),
      }
    : {
        tenant_slug: tenantSlug,
        source_system: sourceSystem,
        cursor_kind: failure.cursor_kind ?? 'marker',
        cursor_value: '',
        last_synced_at: now,
        last_success_at: '',
        consecutive_failures: 1,
        ...(failure.note !== undefined ? { note: failure.note } : {}),
      };
  return writeCursorState(tenantSlug, sourceSystem, state, options);
}

/**
 * Explicit operator reset: deletes the state file so the next sync performs
 * a full re-fetch. Returns true when a file existed and was removed.
 */
export function resetSyncCursor(
  tenantSlug: string,
  sourceSystem: string,
  options: SyncCursorPathOptions = {}
): boolean {
  const file = syncCursorPath(tenantSlug, sourceSystem, options);
  if (!safeExistsSync(file)) return false;
  safeUnlink(file);
  return true;
}
