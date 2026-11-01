import { appendJsonLine, parseSafeJsonInput } from './foundation/json.js';
import { readTextFile } from './foundation/text.js';
import {
  jsonlFileSize,
  streamJsonLines,
  streamTextLines,
  streamTextLinesBackward,
  type JsonlScanOptions,
} from './jsonl-read.js';
import { rotatedSegmentStem } from './append-only-store.js';
import {
  assertSafeRepositoryPath,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeMoveSync,
  safeReaddir,
} from './secure-io.js';
import { validateReadPermission } from './tier-guard.js';
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeLedgerEntryHash,
  createChainAlgTracker,
  GENESIS_HASH,
  getAuditChainKeyId,
  resolveAuditChainKey,
  verifyLedgerEntryHash,
  type ChainAlg,
} from './chain-integrity.js';
import { withLockSync } from './foundation/lock-utils.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeFilter,
} from './event-scope.js';
import { resolveScopeForRecord } from './scope-migration.js';
import { isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { createLogger } from './logger.js';
import {
  PARTITIONED_RUNTIME_LEDGER_ROOTS,
  STORAGE_DATA_TIERS,
  storagePartitionSegments,
  type StorageDataTier,
} from './storage-layout.js';

const logger = createLogger('ledger');

/**
 * Ecosystem Hybrid Ledger v2.0 [STANDARDIZED]
 * Provides a two-layered audit trail:
 * 1. Global System Ledger: Metadata only for system-wide events.
 * 2. Mission Ledger: Detailed execution logs within mission boundaries.
 *
 * Tenant scope never reaches the system ledger. A record whose scope names a
 * tenant — from the record itself, or from its mission's state and location —
 * writes its metadata entry (or, without a mission ledger, its detailed entry)
 * to that tenant's own partition,
 * `active/shared/runtime/tenant-ledger/<personal|confidential>/<tenant>/ledger.jsonl`, as the
 * tenant-bound `tenant_ledger_store` role. Untenanted records keep the system
 * ledger. See knowledge/product/architecture/runtime-storage-layout.md.
 */

/** Repo-relative path of the system ledger (its retention catalog entry). */
export const SYSTEM_LEDGER_REPO_PATH = 'active/audit/system-ledger.jsonl';
export const GLOBAL_LEDGER_PATH = pathResolver.resolve(SYSTEM_LEDGER_REPO_PATH);

/** Repo-relative root of the tier/tenant-partitioned ledgers (storage-layout). */
export const TENANT_LEDGER_ROOT = PARTITIONED_RUNTIME_LEDGER_ROOTS.tenant_ledger;
export const TENANT_LEDGER_FILE = 'ledger.jsonl';

/**
 * D9: a tenant partition is read (hash-chain tail, verification) and appended
 * as `tenant_ledger_store` bound to the record's tenant — a tenant-bound store
 * role whose only grant is that tenant's partition — so recording a tenant
 * mission event never depends on the caller's knowledge-tier grants, and a
 * caller bound to another tenant cannot bind it ([ROLE_TENANT_SCOPE_MISMATCH]).
 */
export const TENANT_LEDGER_STORE_ROLE = 'tenant_ledger_store';

function asTenantLedgerStore<T>(tenantSlug: string, fn: () => T): T {
  return withExecutionContext(TENANT_LEDGER_STORE_ROLE, fn, undefined, tenantSlug);
}

/**
 * Why this process may not bind `tenantSlug` (its active tenant is another
 * one), checked BEFORE any write so a record never half-writes and then
 * throws [ROLE_TENANT_SCOPE_MISMATCH] into a lifecycle step. The message
 * names only this process's own tenant.
 */
function tenantBindingConflict(tenantSlug: string): string | undefined {
  const active = (resolveIdentityContext().tenantSlug || '').trim().toLowerCase();
  return active && active !== tenantSlug.toLowerCase()
    ? `this process is bound to tenant '${active}', not the record's tenant`
    : undefined;
}

/**
 * Storage tier of a tenant partition. Tenant data never lands under an
 * unprotected tier: a `public` tenant record is stored in the tenant's
 * `confidential` partition (a tenant_scope protected prefix); its recorded
 * scope keeps tier `public`.
 */
export function tenantLedgerPartitionTier(tier: StorageDataTier): 'personal' | 'confidential' {
  return tier === 'personal' ? 'personal' : 'confidential';
}

/** Absolute path of one tenant's ledger partition (`<root>/<personal|confidential>/<tenant>/ledger.jsonl`). */
export function tenantLedgerPath(tier: StorageDataTier, tenantSlug: string): string {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`[LEDGER_TENANT_INVALID] '${tenantSlug}' is not a tenant slug`);
  }
  return pathResolver.resolve(
    path.posix.join(
      TENANT_LEDGER_ROOT,
      ...storagePartitionSegments({
        kind: 'tier',
        tier: tenantLedgerPartitionTier(tier),
        tenant: tenantSlug,
      }),
      TENANT_LEDGER_FILE
    )
  );
}

type LedgerRecord = Record<string, unknown>;

const LEDGER_STRING_FIELDS = [
  'id',
  'timestamp',
  'type',
  'role',
  'mission_id',
  'detail_hash',
  'note',
  'parent_hash',
  'chain_alg',
  'chain_key_id',
  'hash',
] as const;

/**
 * Normalize a persisted ledger line before it reaches projections or hash
 * verification. Optional fields preserve old ledger formats, while known
 * envelope fields never silently change type.
 */
export function normalizeLedgerRecord(value: unknown): LedgerRecord | undefined {
  if (!isRecord(value)) return undefined;
  for (const field of LEDGER_STRING_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  if (
    value.chain_alg !== undefined &&
    value.chain_alg !== 'sha256' &&
    value.chain_alg !== 'hmac-sha256'
  ) {
    return undefined;
  }
  for (const field of ['scope', 'scope_context', 'payload'] as const) {
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      (typeof value[field] !== 'object' || Array.isArray(value[field]))
    ) {
      return undefined;
    }
  }
  return value;
}

function safeLedgerPath(ledgerPath: string): string {
  return assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
}

function ensureRegularLedgerFile(ledgerPath: string): void {
  if (safeExistsSync(ledgerPath) && !safeLstat(ledgerPath).isFile()) {
    throw new Error(`[LEDGER_RESOURCE] ledger must be a regular file: ${ledgerPath}`);
  }
}

export const record = (type: string, data: any) => {
  const timestamp = nowIso();
  const missionId = data.mission_id;

  // 1. Locate the mission: its location (what tier-guard enforces) is the
  //    scope authority; its state may only agree with it.
  const mission: MissionResolution =
    missionId && missionId !== 'None' ? resolveMission(String(missionId)) : { kind: 'none' };
  if (mission.kind === 'hidden') {
    // The id exists but is not resolvable by this process (another tenant's,
    // or ambiguous): never put it in the system ledger.
    logger.warn(
      `ledger record skipped — mission ${String(missionId)} is not resolvable by this process | next: record it from a process scoped to the mission's tenant | evidence: ${type}: ${mission.reason}`
    );
    return '';
  }
  const scope = resolveLedgerScope(
    data,
    mission.kind === 'active' || mission.kind === 'archived' ? mission.scope : {}
  );
  const tenantSlug = scope.tenant_slug;
  const refusal =
    (mission.kind === 'active' || mission.kind === 'archived' ? mission.conflict : undefined) ??
    (tenantSlug ? tenantBindingConflict(tenantSlug) : undefined);
  const writeScoped = (entry: Record<string, unknown>): string => {
    if (!tenantSlug) return _writeToLedger(GLOBAL_LEDGER_PATH, entry, { rotate: true });
    const tenantPath = tenantLedgerPath(scope.tier, tenantSlug);
    return asTenantLedgerStore(tenantSlug, () =>
      _writeToLedger(tenantPath, entry, { rotate: true })
    );
  };

  const detail = {
    timestamp,
    type,
    scope,
    role: data.role || 'Unknown',
    mission_id: missionId || 'None',
    payload: data,
  };

  // 2. Without an active mission ledger (no mission, an archived one, or an
  //    unknown id) the detailed entry goes to the scoped ledger: the tenant's
  //    partition, or the system ledger for an untenanted record. A refused
  //    tenant record is skipped — never rerouted to the system ledger.
  if (mission.kind !== 'active') {
    if (refusal) {
      logger.warn(
        `ledger record skipped — ${refusal} | next: record it from a process scoped to the record's tenant, or repair the mission state | evidence: ${type} mission ${String(missionId ?? 'None')}`
      );
      return '';
    }
    if (mission.kind === 'unknown' && !tenantSlug) {
      // D4: an id no process can place may belong to a tenant this process
      // cannot see; its payload never reaches the system ledger. The raw id
      // stays for correlation; no digest of the payload is kept.
      logger.warn(
        `ledger payload withheld — mission id is not placeable by this process | next: record it with an explicit tenant_slug, or from a process that can resolve the mission | evidence: ${type} mission ${String(missionId)}`
      );
      return writeScoped({
        timestamp,
        type,
        scope: unplaceableMissionScope(scope.tier, String(missionId)),
        role: data.role || 'Unknown',
        mission_id: String(missionId),
        payload_withheld: 'mission_unplaceable',
        note: 'Metadata only. The mission id is not placeable; its payload was withheld.',
      });
    }
    return writeScoped(detail);
  }

  // 3. Detailed entry in the mission's evidence ledger; metadata entry in the
  //    scoped ledger (never the system ledger for a tenant mission). The
  //    detailed entry is durable evidence, so a refused or failed metadata
  //    entry is a diagnostic warn, never an error thrown into the lifecycle
  //    step that recorded it after changing state.
  // Mission evidence ledgers never rotate: they are bounded by the mission's
  // life, and their readers (mission-distill) read the live file only.
  const detailHash = _writeToLedger(
    safeLedgerPath(path.join(mission.path, 'evidence/ledger.jsonl')),
    detail,
    { rotate: false }
  );
  if (refusal) {
    logger.warn(
      `ledger metadata entry skipped — ${refusal} | next: record it from a process scoped to the mission's tenant, or repair the mission state | evidence: ${type} mission ${String(missionId)} detail ${detailHash}`
    );
    return detailHash;
  }
  try {
    writeScoped({
      timestamp,
      type: `MISSION_EVENT:${type}`,
      scope,
      role: data.role || 'Unknown',
      mission_id: missionId,
      detail_hash: detailHash, // Link to the detailed ledger
      note: 'Metadata only. See mission evidence for details.',
    });
  } catch (err) {
    logger.warn(
      `ledger metadata entry not written — ${err instanceof Error ? err.message : String(err)} | next: run pnpm audit:verify and repair the scoped ledger | evidence: ${type} mission ${String(missionId)} detail ${detailHash}`
    );
  }
  return detailHash;
};

/** Mission-kind scope of an unplaceable id; system scope when the id is not scope-shaped. */
function unplaceableMissionScope(tier: EventScope['tier'], missionId: string): EventScope {
  try {
    return normalizeEventScope({ tier, scope_kind: 'mission', mission_id: missionId });
  } catch {
    return normalizeEventScope({ tier, scope_kind: 'system' });
  }
}

type MissionResolution =
  | { kind: 'none' }
  | { kind: 'active'; path: string; scope: MissionLedgerScope; conflict?: string }
  | { kind: 'archived'; scope: MissionLedgerScope; conflict?: string }
  | { kind: 'hidden'; reason: string }
  | { kind: 'unknown' };

/**
 * Where a mission id lives: an active mission dir, an archived one (its
 * scope still routes the record to the tenant), not resolvable by this
 * process (the locator refused it), or nowhere this process can see. An
 * unknown id stays a system record — the residual case documented in
 * runtime-storage-layout.md.
 */
function resolveMission(missionId: string): MissionResolution {
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  try {
    const found = pathResolver.findMissionPath(missionId);
    if (found) return { kind: 'active', path: found, ...missionLedgerScope(found) };
  } catch (err) {
    return { kind: 'hidden', reason: errorText(err) };
  }
  try {
    const archived = pathResolver.findArchivedMissionDir(missionId);
    if (archived) return { kind: 'archived', ...missionLedgerScope(archived) };
  } catch (err) {
    return { kind: 'hidden', reason: errorText(err) };
  }
  return { kind: 'unknown' };
}

interface MissionLedgerScope {
  tier?: StorageDataTier;
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
}

/** `active/missions/<tier>/[<tenant|shared>/]<id>` (archive and legacy knowledge homes too). */
const MISSION_LOCATION =
  /^(?:active\/(?:archive\/)?missions|knowledge)\/(personal|confidential|public)\/(?:missions\/)?(?:([^/]+)\/)?[^/]+$/u;

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A nested string field of an untrusted record (`a.b.c`), or undefined. */
function nestedString(value: unknown, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return stringField(current);
}

function loadMissionStateRecord(missionPath: string): Record<string, unknown> | null {
  try {
    const statePath = path.join(missionPath, 'mission-state.json');
    if (!safeExistsSync(statePath)) return null;
    const parsed = parseSafeJsonInput(readTextFile(statePath), 'mission state');
    return isRecord(parsed) ? parsed : null;
  } catch (err) {
    logger.debug(
      `mission state unreadable for ledger scope — using the mission location only | next: none | evidence: ${missionPath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Scope of a mission from its LOCATION — what tier-guard enforces — with the
 * state file (data a worker may edit) only allowed to agree. A state whose
 * tenant or tier disagrees with the location (including a state naming a
 * tenant its location does not carry) yields `conflict`, and the record's
 * tenant-scoped entry is refused. Organization and project come from the
 * state, only inside the located tenant. Nothing here invents a tenant.
 */
function missionLedgerScope(missionPath: string): {
  scope: MissionLedgerScope;
  conflict?: string;
} {
  const relative = path.relative(pathResolver.rootDir(), missionPath).split(path.sep).join('/');
  const located = MISSION_LOCATION.exec(relative);
  const locatedTier = located?.[1] as StorageDataTier | undefined;
  const locatedTenant =
    located?.[2] && located[2] !== 'shared' && isValidTenantSlug(located[2])
      ? located[2]
      : undefined;
  const state = loadMissionStateRecord(missionPath);
  const rawTier = nestedString(state, 'tier');
  const stateTier = STORAGE_DATA_TIERS.includes(rawTier as StorageDataTier)
    ? (rawTier as StorageDataTier)
    : undefined;
  const stateTenant = nestedString(state, 'tenant_slug')?.toLowerCase();
  let conflict: string | undefined;
  if ((stateTenant || undefined) !== locatedTenant) {
    conflict = locatedTenant
      ? `mission state names another tenant than the mission's location (${relative})`
      : `mission state names a tenant the mission's location does not carry (${relative})`;
  } else if (stateTier && locatedTier && stateTier !== locatedTier) {
    conflict = `mission state tier '${stateTier}' disagrees with the mission's location (${relative})`;
  }
  const tenant = locatedTenant;
  const tier = locatedTier || stateTier;
  const organization =
    nestedString(state, 'organization_id') ||
    nestedString(state, 'relationships', 'organization', 'organization_id');
  const project = nestedString(state, 'relationships', 'project', 'project_id');
  return {
    scope: {
      ...(tier ? { tier } : {}),
      ...(tenant ? { tenant_slug: tenant } : {}),
      ...(tenant && organization ? { organization_id: organization } : {}),
      ...(tenant && organization && project ? { project_id: project } : {}),
    },
    ...(conflict ? { conflict } : {}),
  };
}

/**
 * Internal helper to write an entry with hash chaining to a specific file.
 *
 * MSN-STORE-BOUNDS-3: the chain spans rotated segments. When the live file
 * is absent or blank and a segment exists (it was just rotated), the chain
 * continues from the newest segment's last hash, and the live file opens
 * with a chained {@link LEDGER_SEGMENT_OPENED_TYPE} marker naming that
 * segment before the entry itself. After the append, a live file past
 * {@link LEDGER_SEGMENT_ROTATE_BYTES} is renamed to a dated segment — under
 * this same lock, and never failing the append. Only the system ledger and
 * the tenant partitions rotate (`rotate: true`); mission evidence ledgers
 * stay one file.
 */
function _writeToLedger(ledgerPath: string, entryData: any, options: { rotate: boolean }): string {
  ledgerPath = safeLedgerPath(ledgerPath);
  const lockId = `ledger-${createHash('sha256').update(ledgerPath).digest('hex')}`;
  return withLockSync(lockId, () => {
    const tail = resolveChainTail(ledgerPath);
    const chainKey = resolveAuditChainKey({ createIfMissing: true });
    if (!chainKey) throw new Error('missing_audit_chain_key');

    const dir = path.dirname(ledgerPath);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }

    const appendChained = (data: Record<string, unknown>, parentHash: string): string => {
      const entry: any = {
        ...data,
        parent_hash: parentHash,
        chain_alg: 'hmac-sha256' satisfies ChainAlg,
        chain_key_id: getAuditChainKeyId(chainKey),
      };
      const hash = computeLedgerEntryHash(entry, { alg: 'hmac-sha256', key: chainKey });
      entry.hash = hash;
      appendJsonLine(ledgerPath, entry);
      return hash;
    };

    const parentHash = tail.openedFrom
      ? appendChained(segmentOpenedMarker(entryData, tail.openedFrom, tail.hash), tail.hash)
      : tail.hash;
    const hash = appendChained(entryData, parentHash);
    if (options.rotate) rotateLedgerIfDue(ledgerPath);
    return hash;
  });
}

/**
 * Chained entry type that opens a live file after a rotation: its
 * `parent_hash` is the previous segment's last hash and its payload names
 * that segment, so a chain whose older segments were archived away still
 * verifies from an HMAC-authenticated anchor.
 */
export const LEDGER_SEGMENT_OPENED_TYPE = 'LEDGER_SEGMENT_OPENED';

/**
 * Chained, keyed receipt the governed janitor appends to the live ledger when
 * it archives a rotated segment away: names the segment and its last hash.
 * A chain whose oldest present file opens with a segment marker verifies
 * only when such a receipt for the marker's previous segment is on the
 * verified chain — deleting segments by hand never yields a clean report.
 */
export const LEDGER_SEGMENT_ARCHIVED_TYPE = 'LEDGER_SEGMENT_ARCHIVED';

export interface LedgerSegmentArchivedReceipt {
  /** The archived segment (its basename is recorded). */
  segment: string;
  /** Hash of the segment's last entry. */
  last_hash: string;
  /** Where the segment now lives (repo-relative). */
  archive_path: string;
}

/**
 * Record that a rotated segment of the system ledger was archived away, as a
 * keyed, chained entry on the live ledger (under the ledger lock). Only the
 * system ledger is archived by code; tenant partitions are moved only by an
 * operator decision or the offboarding ceremony, so this API refuses them.
 */
export function recordLedgerSegmentArchived(
  receipt: LedgerSegmentArchivedReceipt,
  ledgerPath: string = GLOBAL_LEDGER_PATH
): string {
  const safePath = safeLedgerPath(ledgerPath);
  if (safePath !== safeLedgerPath(GLOBAL_LEDGER_PATH)) {
    throw new Error(
      `[LEDGER_ARCHIVE_RECEIPT_REFUSED] only system ledger segments are archived by code | next: move tenant ledger segments only through the offboarding ceremony | evidence: ${repoRelative(safePath)}`
    );
  }
  return _writeToLedger(
    safePath,
    {
      timestamp: nowIso(),
      type: LEDGER_SEGMENT_ARCHIVED_TYPE,
      scope: normalizeEventScope({ tier: 'public', scope_kind: 'system' }),
      role: 'storage_janitor',
      mission_id: 'None',
      payload: {
        segment: path.basename(receipt.segment),
        last_hash: receipt.last_hash,
        archive_path: receipt.archive_path,
      },
      note: 'A rotated ledger segment was archived by the storage janitor.',
    },
    { rotate: true }
  );
}

/**
 * Hash of a rotated segment's last entry (for the archive receipt). Throws
 * when the segment holds no entry or its tail cannot be read.
 */
export function ledgerSegmentLastHash(segmentPath: string): string {
  const hash = readTailHash(safeLedgerPath(segmentPath));
  if (hash === undefined) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger segment holds no entry | next: inspect the segment before archiving it | evidence: ${repoRelative(segmentPath)}`
    );
  }
  return hash;
}

/** Live ledger size past which the append that crossed it rotates it to a dated segment. */
export const LEDGER_SEGMENT_ROTATE_BYTES = 64 * 1024 * 1024;

interface LedgerRotationOptions {
  /** Rotation threshold in bytes (default {@link LEDGER_SEGMENT_ROTATE_BYTES}). */
  maxBytes?: number;
  /** Clock for segment stamps. */
  now?: () => Date;
}

let ledgerRotationOptions: LedgerRotationOptions = {};
/** Live size at the last failed rotation per ledger — retry only once it doubles. */
const rotationBackoff = new Map<string, number>();

/** Test seam: inject a small rotation threshold / clock (pass `{}` to reset). */
export function setLedgerRotationOptionsForTests(options: LedgerRotationOptions): void {
  ledgerRotationOptions = { ...options };
  rotationBackoff.clear();
}

function segmentOpenedMarker(
  entryData: Record<string, unknown>,
  previousSegment: string,
  previousLastHash: string
): Record<string, unknown> {
  return {
    timestamp: nowIso(),
    type: LEDGER_SEGMENT_OPENED_TYPE,
    scope: markerScope(entryData.scope),
    role: 'ledger',
    mission_id: 'None',
    payload: {
      previous_segment: path.basename(previousSegment),
      previous_last_hash: previousLastHash,
    },
    note: 'Chain continues from the previous ledger segment.',
  };
}

/** The tier/tenant of the entry that opened the file (system scope when untenanted). */
function markerScope(scope: unknown): EventScope {
  const rawTier = nestedString(scope, 'tier');
  const tier = STORAGE_DATA_TIERS.includes(rawTier as StorageDataTier)
    ? (rawTier as StorageDataTier)
    : undefined;
  const tenant = nestedString(scope, 'tenant_slug');
  if (tenant) {
    try {
      return normalizeEventScope({ tier: tier ?? 'confidential', tenant_slug: tenant });
    } catch {
      return normalizeEventScope({ tier: 'confidential', tenant_slug: tenant });
    }
  }
  return normalizeEventScope({ tier: tier ?? 'public', scope_kind: 'system' });
}

interface LedgerSegment {
  path: string;
  stamp: string;
  seq: number;
}

const SEGMENT_SUFFIX = /^(\d{8})-(\d{6})(?:-(\d+))?\.jsonl$/u;

/**
 * Rotated segments of a ledger (`<stem>-YYYYMMDD-HHmmss[-n].jsonl` beside it),
 * oldest first: by stamp, then by rotatedSegmentPath's collision suffix
 * (numeric, so `-10` follows `-9` and the unsuffixed name comes first).
 * Rotation never stamps a segment older than the newest one, so this order is
 * the chain order across processes. A directory that cannot be listed
 * throws: skipping segments would hide history from verification.
 */
function ledgerSegmentsOf(ledgerPath: string): LedgerSegment[] {
  const dir = path.dirname(ledgerPath);
  if (!safeExistsSync(dir)) return [];
  const prefix = `${rotatedSegmentStem(ledgerPath)}-`;
  const segments: LedgerSegment[] = [];
  for (const name of safeReaddir(dir)) {
    if (!name.startsWith(prefix)) continue;
    const match = SEGMENT_SUFFIX.exec(name.slice(prefix.length));
    if (!match) continue;
    segments.push({
      path: path.join(dir, name),
      stamp: `${match[1]}-${match[2]}`,
      seq: match[3] ? Number(match[3]) : 0,
    });
  }
  return segments.sort((a, b) =>
    a.stamp === b.stamp ? a.seq - b.seq : a.stamp < b.stamp ? -1 : 1
  );
}

/**
 * Whether `name` is a file of the chain whose live file is `ledgerFileName`
 * (e.g. `ledger.jsonl`): the live file itself or one of its rotated segments.
 */
export function isLedgerChainFileName(ledgerFileName: string, name: string): boolean {
  if (name === ledgerFileName) return true;
  const prefix = `${rotatedSegmentStem(ledgerFileName)}-`;
  return name.startsWith(prefix) && SEGMENT_SUFFIX.test(name.slice(prefix.length));
}

/** Rotated segment paths of a ledger, oldest first (chain order). */
export function listLedgerSegments(ledgerPath: string = GLOBAL_LEDGER_PATH): string[] {
  return ledgerSegmentsOf(safeLedgerPath(ledgerPath)).map((segment) => segment.path);
}

/** Every file of one ledger chain in order: segments, then the live file when it exists. */
function ledgerChainFiles(safePath: string): string[] {
  const files = ledgerSegmentsOf(safePath).map((segment) => segment.path);
  if (safeExistsSync(safePath)) files.push(safePath);
  return files;
}

/**
 * The name the next rotation renames the live file to: always sorts after
 * every existing segment, so segment order stays chain order. A clock that
 * went backward (or one second holding several rotations) reuses the newest
 * stamp with the newest suffix + 1 — never the first free suffix, which could
 * be a name freed by archiving and sort before the newest segment.
 */
function nextLedgerSegmentPath(ledgerPath: string, now: Date): string {
  const nowStamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const segments = ledgerSegmentsOf(ledgerPath);
  const newest = segments.at(-1);
  const stamp = newest && newest.stamp >= nowStamp ? newest.stamp : nowStamp;
  let seq = newest && newest.stamp === stamp ? newest.seq + 1 : 0;
  const base = path.join(path.dirname(ledgerPath), `${rotatedSegmentStem(ledgerPath)}-${stamp}`);
  const nameOf = (n: number) => `${base}${n > 0 ? `-${n}` : ''}.jsonl`;
  while (safeExistsSync(nameOf(seq))) seq += 1;
  return nameOf(seq);
}

function repoRelative(filePath: string): string {
  return path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
}

/**
 * Rotate the live ledger once it passes the threshold. Runs under the
 * ledger's lock (the caller holds it). Never throws: a failure (e.g. a role
 * whose write scope does not cover the segment name) warns, backs off until
 * the file doubles, and the append that triggered it stands.
 */
function rotateLedgerIfDue(ledgerPath: string): void {
  const threshold = ledgerRotationOptions.maxBytes ?? LEDGER_SEGMENT_ROTATE_BYTES;
  let size = 0;
  try {
    size = jsonlFileSize(ledgerPath);
    if (size < threshold) return;
    const failedAt = rotationBackoff.get(ledgerPath);
    if (failedAt !== undefined && size < 2 * failedAt) return;
    const segment = nextLedgerSegmentPath(ledgerPath, ledgerRotationOptions.now?.() ?? new Date());
    safeMoveSync(ledgerPath, segment);
    rotationBackoff.delete(ledgerPath);
    if (segment) {
      logger.info(
        `ledger rotated — live file reached ${size} bytes (threshold ${threshold}); the hash chain continues in a fresh live file | next: none | evidence: ${repoRelative(segment)}`
      );
    }
  } catch (err) {
    rotationBackoff.set(ledgerPath, size);
    logger.warn(
      `ledger rotation failed — ${err instanceof Error ? err.message : String(err)} | next: the append succeeded and the live file keeps growing; rotation retries once it doubles — check the writer role's write scope on the ledger directory | evidence: ${repoRelative(ledgerPath)} ${size} bytes, threshold ${threshold}`
    );
  }
}

/**
 * Range-read options for the ledger's tail and verify scans. Production uses
 * the jsonl-read defaults; tests inject a small chunk size so multi-chunk
 * files stay tiny.
 */
let ledgerScanOptions: JsonlScanOptions = {};

/** Test seam: override the ledger's range-read options (pass `{}` to reset). */
export function setLedgerScanOptionsForTests(options: JsonlScanOptions): void {
  ledgerScanOptions = { ...options };
}

/** The last non-blank line of the ledger, read backward in chunks (O(tail), not O(file)). */
function readLedgerTailLine(ledgerPath: string): string | undefined {
  for (const line of streamTextLinesBackward(ledgerPath, {
    ...ledgerScanOptions,
    onOversized: (oversized) => {
      throw new Error(`tail line ${oversized.lineNumber} from the end exceeds the line guard`);
    },
  })) {
    if (line.text.trim()) return line.text;
  }
  return undefined;
}

/**
 * The last entry hash of one chain file, or undefined when it holds no
 * entry. An existing file whose tail cannot be read or parsed must not
 * restart the chain at genesis (that would silently fork it): fail with a
 * diagnostic. record() keeps a metadata-entry failure non-fatal. A torn last
 * line (a writer that died mid-append) fails the same way: appending after it
 * would glue the new entry onto the fragment.
 */
function readTailHash(filePath: string): string | undefined {
  ensureRegularLedgerFile(filePath);
  let tailHash: unknown;
  try {
    const tail = readLedgerTailLine(filePath);
    if (tail === undefined) return undefined;
    const lastEntry = normalizeLedgerRecord(parseSafeJsonInput(tail, 'ledger tail entry'));
    tailHash = lastEntry?.hash;
  } catch (err) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger tail cannot be read — appending would fork its hash chain | next: run pnpm audit:verify and repair the ledger | evidence: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof tailHash !== 'string' || !tailHash) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger tail entry has no hash — appending would fork its hash chain | next: run pnpm audit:verify and repair the ledger | evidence: ${filePath}`
    );
  }
  return tailHash;
}

/**
 * Where the next append chains from: the live file's last hash; when the
 * live file is absent or blank (just rotated), the newest non-blank
 * segment's last hash — `openedFrom` names that segment so the append opens
 * the live file with a marker; genesis only for a ledger with no entry in
 * any file. Never restarts at genesis while a segment holds entries.
 */
function resolveChainTail(ledgerPath: string): { hash: string; openedFrom?: string } {
  ledgerPath = safeLedgerPath(ledgerPath);
  if (safeExistsSync(ledgerPath)) {
    const live = readTailHash(ledgerPath);
    if (live !== undefined) return { hash: live };
  }
  let segments: LedgerSegment[];
  try {
    segments = ledgerSegmentsOf(ledgerPath);
  } catch (err) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger segments cannot be listed — appending from genesis could fork its hash chain | next: check read access to the ledger directory and run pnpm audit:verify | evidence: ${ledgerPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  for (const segment of [...segments].reverse()) {
    const hash = readTailHash(segment.path);
    if (hash !== undefined) return { hash, openedFrom: segment.path };
  }
  return { hash: GENESIS_HASH };
}

export interface LedgerIntegrityReport {
  ok: boolean;
  total: number;
  corrupted: string[];
  missingKey: boolean;
  /** Unkeyed (`sha256`) entries: a legacy prefix anyone could recompute. */
  unkeyed: number;
  /** Rotated segments verified before the live file (repo-relative, chain order). */
  segments?: string[];
  /**
   * The chain's oldest present file opens with a keyed segment marker instead
   * of genesis: older segments were archived away. Names the segment the
   * marker continues from. Clean only when a keyed
   * {@link LEDGER_SEGMENT_ARCHIVED_TYPE} receipt for that segment and its last
   * hash is on the verified chain; otherwise a
   * `chain_start:<file>:unproven_anchor:<segment>` finding is reported.
   */
  anchoredFrom?: string;
}

export interface LedgerIntegrityOptions {
  /** Every entry must be keyed: for chains born after HMAC hardening (tenant partitions). */
  requireKeyed?: boolean;
}

/**
 * Verify the integrity of a specific ledger file
 */
export const verifyIntegrity = (ledgerPath: string = GLOBAL_LEDGER_PATH): boolean => {
  return verifyLedgerIntegrityDetailed(ledgerPath).ok;
};

export const verifyLedgerIntegrityDetailed = (
  ledgerPath: string = GLOBAL_LEDGER_PATH,
  options: LedgerIntegrityOptions = {}
): LedgerIntegrityReport => {
  const safePath = safeLedgerPath(ledgerPath);
  ensureRegularLedgerFile(safePath);
  // MSN-STORE-BOUNDS-3: one chain across rotated segments (oldest first),
  // then the live file. Each segment's first entry must link to the previous
  // file's last hash; a break names the segment.
  const files = ledgerChainFiles(safePath);
  const segments = files.filter((file) => file !== safePath).map(repoRelative);
  if (files.length === 0) {
    return { ok: true, total: 0, corrupted: [], missingKey: false, unkeyed: 0 };
  }

  let expectedParentHash = GENESIS_HASH;
  const corrupted: string[] = [];
  let total = 0;
  let missingKey = false;
  let anchoredFrom: string | undefined;
  let anchor: { file: string; previousLastHash: string } | undefined;
  /** `<segment>\u0000<last_hash>` of every keyed, verified archive receipt. */
  const receipts = new Set<string>();
  let chainStarted = false;
  let previousFile: string | undefined;
  const algTracker = createChainAlgTracker(options);

  for (const file of files) {
    ensureRegularLedgerFile(file);
    // Live-file findings keep their historic `line:N:...` form; segment
    // findings are prefixed with the segment's repo-relative path.
    const label = file === safePath ? '' : `${repoRelative(file)}:`;
    let firstInFile = true;
    // Forward stream in fixed chunks: constant memory, no whole-file size cap.
    const lines = streamTextLines(file, {
      ...ledgerScanOptions,
      onOversized: (oversized) => {
        total++;
        corrupted.push(`${label}line:${oversized.lineNumber}:parse_error`);
      },
    });
    for (const { text: line, lineNumber } of lines) {
      if (!line.trim()) continue;
      total++;
      const opensFile = firstInFile;
      firstInFile = false;
      try {
        const entry = normalizeLedgerRecord(parseSafeJsonInput(line, 'ledger entry'));
        if (!entry) {
          corrupted.push(`${label}line:${lineNumber}:invalid_record`);
          continue;
        }
        const chainAlg = (entry.chain_alg ?? 'sha256') as ChainAlg;
        const algFinding = algTracker.observe(chainAlg);
        const chainKey =
          chainAlg === 'hmac-sha256' ? resolveAuditChainKey({ createIfMissing: false }) : null;
        const marker = segmentMarkerOf(entry);
        if (!chainStarted && marker && chainAlg === 'hmac-sha256') {
          // Older segments were archived: the keyed marker is the anchor
          // (its HMAC still has to verify below).
          expectedParentHash = marker.previousLastHash;
          anchoredFrom = marker.previousSegment;
          anchor = { file, previousLastHash: marker.previousLastHash };
        }
        chainStarted = true;
        const check = verifyLedgerEntryHash(entry, expectedParentHash, {
          alg: chainAlg,
          ...(chainKey ? { key: chainKey } : {}),
        });
        const boundary = opensFile && previousFile !== undefined;
        if (
          boundary &&
          marker &&
          previousFile &&
          marker.previousSegment !== path.basename(previousFile)
        ) {
          corrupted.push(
            `segment_boundary:${repoRelative(file)}:marker_names:${marker.previousSegment}`
          );
        }
        if (algFinding) {
          corrupted.push(
            `${label}line:${lineNumber}:${algFinding}${check.ok ? '' : `+${check.reason ?? 'invalid'}`}`
          );
        } else if (!check.ok && boundary && check.reason === 'parent_hash_mismatch') {
          corrupted.push(
            `segment_boundary:${repoRelative(file)}:parent_hash_mismatch:after:${repoRelative(previousFile as string)}`
          );
        } else if (
          !check.ok &&
          opensFile &&
          segments.length > 0 &&
          check.reason === 'parent_hash_mismatch'
        ) {
          corrupted.push(`chain_start:${repoRelative(file)}:parent_hash_mismatch`);
        } else if (!check.ok) {
          if (check.reason === 'missing_audit_chain_key') missingKey = true;
          corrupted.push(
            entry.id
              ? `${label}${String(entry.id)}`
              : `${label}line:${lineNumber}:${check.reason ?? 'invalid'}`
          );
        }
        const receipt =
          check.ok && chainAlg === 'hmac-sha256' ? archiveReceiptOf(entry) : undefined;
        if (receipt) receipts.add(receipt);
        expectedParentHash = String(entry.hash ?? '');
      } catch (_e) {
        corrupted.push(`${label}line:${lineNumber}:parse_error`);
      }
    }
    if (!firstInFile) previousFile = file;
  }
  // Anchoring on a marker is legitimate only when the governed janitor
  // archived the previous segment and said so on the chain.
  if (anchor && anchoredFrom && !receipts.has(`${anchoredFrom}\u0000${anchor.previousLastHash}`)) {
    corrupted.push(`chain_start:${repoRelative(anchor.file)}:unproven_anchor:${anchoredFrom}`);
  }
  return {
    ok: corrupted.length === 0,
    total,
    corrupted,
    missingKey,
    unkeyed: algTracker.unkeyed,
    ...(segments.length > 0 ? { segments } : {}),
    ...(anchoredFrom ? { anchoredFrom } : {}),
  };
};

/** `<segment>\u0000<last_hash>` of an archive receipt entry, if `entry` is one. */
function archiveReceiptOf(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== LEDGER_SEGMENT_ARCHIVED_TYPE) return undefined;
  const segment = nestedString(entry.payload, 'segment');
  const lastHash = nestedString(entry.payload, 'last_hash');
  return segment && lastHash ? `${segment}\u0000${lastHash}` : undefined;
}

/** The continuation payload of a segment-opened marker entry, if `entry` is one. */
function segmentMarkerOf(
  entry: Record<string, unknown>
): { previousSegment: string; previousLastHash: string } | undefined {
  if (entry.type !== LEDGER_SEGMENT_OPENED_TYPE) return undefined;
  const previousSegment = nestedString(entry.payload, 'previous_segment');
  const previousLastHash = nestedString(entry.payload, 'previous_last_hash');
  if (!previousSegment || !previousLastHash || previousLastHash !== entry.parent_hash) {
    return undefined;
  }
  return { previousSegment, previousLastHash };
}

export interface TenantLedgerPartition {
  tier: StorageDataTier;
  tenant_slug: string;
  path: string;
}

function listDirectory(dir: string): string[] {
  try {
    return safeExistsSync(dir) ? safeReaddir(dir).sort() : [];
  } catch (err) {
    logger.debug(
      `tenant ledger listing skipped — unreadable directory | next: check the ledger root | evidence: ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Every tenant ledger partition that holds a chain
 * (`<root>/<personal|confidential>/<tenant>/ledger.jsonl`, or only rotated
 * segments right after a rotation). `path` is always the live file path.
 */
export function listTenantLedgerPartitions(): TenantLedgerPartition[] {
  const root = pathResolver.resolve(TENANT_LEDGER_ROOT);
  const partitions: TenantLedgerPartition[] = [];
  for (const tier of listDirectory(root)) {
    // Partitions exist only under the protected tiers (tenantLedgerPartitionTier).
    if (tier !== 'personal' && tier !== 'confidential') continue;
    for (const tenant of listDirectory(path.join(root, tier))) {
      if (!isValidTenantSlug(tenant)) continue;
      const filePath = tenantLedgerPath(tier as StorageDataTier, tenant);
      try {
        if (safeExistsSync(filePath) || partitionHasSegments(tenant, filePath)) {
          partitions.push({ tier: tier as StorageDataTier, tenant_slug: tenant, path: filePath });
        }
      } catch {
        // A partition this process may not even probe is simply not listed.
      }
    }
  }
  return partitions;
}

/**
 * Whether a partition without a live file still holds rotated segments,
 * listed as its tenant-bound store role. A listing this process may not make
 * (a caller bound to another tenant) counts as present, so the verifier
 * withholds it rather than silently dropping it.
 */
function partitionHasSegments(tenantSlug: string, livePath: string): boolean {
  if (!safeExistsSync(path.dirname(livePath))) return false;
  try {
    return asTenantLedgerStore(tenantSlug, () => ledgerSegmentsOf(livePath).length > 0);
  } catch {
    return true;
  }
}

export interface ScopedLedgerIntegrityReport extends LedgerIntegrityReport {
  path: string;
  tier?: StorageDataTier;
  tenant_slug?: string;
}

/**
 * Verify one tenant partition's hash chain as the tenant-bound store role.
 * Throws when this process may not bind that tenant (a tenant-bound caller
 * asking for another tenant).
 */
export function verifyTenantLedgerIntegrity(
  tier: StorageDataTier,
  tenantSlug: string
): ScopedLedgerIntegrityReport {
  const ledgerPath = tenantLedgerPath(tier, tenantSlug);
  // Partitions were born after HMAC hardening (D9): no unkeyed legacy prefix.
  const report = asTenantLedgerStore(tenantSlug, () =>
    verifyLedgerIntegrityDetailed(ledgerPath, { requireKeyed: true })
  );
  return {
    ...report,
    path: ledgerPath,
    tier: tenantLedgerPartitionTier(tier),
    tenant_slug: tenantSlug,
  };
}

export interface AllLedgerIntegrityReport {
  ok: boolean;
  ledgers: ScopedLedgerIntegrityReport[];
  /** Tenant partitions this process may not verify (other tenants of a bound caller). */
  withheld: number;
}

/**
 * Verify the system ledger and every tenant partition this process may bind
 * (each file is its own hash chain). A partition of another tenant than the
 * caller's bound tenant is counted as withheld, never read.
 */
export function verifyAllLedgerIntegrity(): AllLedgerIntegrityReport {
  const ledgers: ScopedLedgerIntegrityReport[] = [
    { ...verifyLedgerIntegrityDetailed(GLOBAL_LEDGER_PATH), path: GLOBAL_LEDGER_PATH },
  ];
  let withheld = 0;
  for (const partition of listTenantLedgerPartitions()) {
    try {
      ledgers.push(verifyTenantLedgerIntegrity(partition.tier, partition.tenant_slug));
    } catch (err) {
      withheld += 1;
      logger.debug(
        // Never name the other tenant to a bound caller.
        `tenant ledger verification skipped — this process may not bind that partition's tenant | next: verify from an unbound operator process or as that tenant | evidence: a ${partition.tier} partition: ${err instanceof Error && /ROLE_TENANT_SCOPE_MISMATCH/u.test(err.message) ? 'ROLE_TENANT_SCOPE_MISMATCH' : 'verification failed'}`
      );
    }
  }
  return { ok: ledgers.every((ledger) => ledger.ok), ledgers, withheld };
}

/**
 * Verify the ledgers a scope's events land in: the system ledger, plus the
 * tenant's partition when the scope names a tenant.
 */
export function verifyScopedIntegrity(scope: { tier?: string; tenant_slug?: string }): boolean {
  if (!verifyIntegrity(GLOBAL_LEDGER_PATH)) return false;
  const tenant = stringField(scope.tenant_slug);
  if (!tenant || !isValidTenantSlug(tenant)) return true;
  const tier = STORAGE_DATA_TIERS.includes(scope.tier as StorageDataTier)
    ? (scope.tier as StorageDataTier)
    : 'confidential';
  return verifyTenantLedgerIntegrity(tier, tenant).ok;
}

/**
 * Scoped history of one ledger chain: every rotated segment (oldest first),
 * then the live file — a scoped read is a history reader, so rotation never
 * hides older entries from it.
 */
function readScopedEntries(safePath: string, filter: EventScopeFilter): Record<string, unknown>[] {
  ensureRegularLedgerFile(safePath);
  // Forward stream: a scoped read never fails on the ledger's size.
  const matched: Record<string, unknown>[] = [];
  for (const file of ledgerChainFiles(safePath)) {
    ensureRegularLedgerFile(file);
    for (const value of streamJsonLines<unknown>(file, {
      ...ledgerScanOptions,
      onMalformed: 'skip',
    })) {
      try {
        const entry = normalizeLedgerRecord(value);
        if (!entry) continue;
        const scopeResult = resolveScopeForRecord(entry);
        if (scopeResult.disposition === 'invalid') continue;
        if (eventScopeMatches(scopeResult.scope, filter)) matched.push(entry);
      } catch {
        continue;
      }
    }
  }
  return matched;
}

/** Tenants a filter names explicitly ('all' = every partition). */
function filterTenants(filter: EventScopeFilter): string[] | 'all' {
  if (filter.tenant_slugs === 'all') return 'all';
  return [...(filter.tenant_slugs ?? []), ...(filter.tenant_slug ? [filter.tenant_slug] : [])];
}

/**
 * Read ledger entries through the same explicit scope contract as events.
 * With the default path this is the system ledger plus — for a filter that
 * names tenants — those tenants' partitions, each read under the caller's own
 * tier-guard decision (a partition this reader may not see is skipped, never
 * widened by the filter). An explicit path reads that one chain (its segments, then the live file).
 */
export const loadForScope = (
  filter: EventScopeFilter,
  ledgerPath: string = GLOBAL_LEDGER_PATH
): Record<string, unknown>[] => {
  const safePath = safeLedgerPath(ledgerPath);
  const entries = readScopedEntries(safePath, filter);
  if (ledgerPath !== GLOBAL_LEDGER_PATH) return entries;
  const tenants = filterTenants(filter);
  if (tenants !== 'all' && tenants.length === 0) return entries;
  const partitions =
    tenants === 'all'
      ? listTenantLedgerPartitions()
      : tenants.flatMap((tenant) =>
          isValidTenantSlug(tenant)
            ? (['personal', 'confidential'] as const).map((tier) => ({
                tier,
                tenant_slug: tenant,
                path: tenantLedgerPath(tier, tenant),
              }))
            : []
        );
  for (const partition of partitions) {
    const decision = validateReadPermission(partition.path);
    if (!decision.allowed) {
      logger.debug(
        `tenant ledger partition skipped — tier-guard denies this reader | next: read as a persona and tenant binding allowed for this tier | evidence: ${partition.tier}/${partition.tenant_slug}: ${decision.reason ?? 'denied'}`
      );
      continue;
    }
    try {
      // A partition right after rotation has segments but no live file yet.
      if (!safeExistsSync(partition.path) && !safeExistsSync(path.dirname(partition.path))) {
        continue;
      }
    } catch {
      continue;
    }
    entries.push(...readScopedEntries(safeLedgerPath(partition.path), filter));
  }
  return entries;
};

/**
 * Scope of a ledger record. The mission's own scope (state + location) is the
 * authority for tier, tenant, organization and project: it fills what the
 * record omits and wins over a conflicting value, so a tenant mission is never
 * recorded as public or untenanted.
 */
function resolveLedgerScope(
  data: Record<string, unknown>,
  mission: MissionLedgerScope = {}
): EventScope {
  const source =
    data.scope && typeof data.scope === 'object' && !Array.isArray(data.scope)
      ? (data.scope as Record<string, unknown>)
      : data;
  const missionTenant = mission.tenant_slug;
  const candidate = {
    ...source,
    ...(typeof data.tenant_slug === 'string' ? { tenant_slug: data.tenant_slug } : {}),
    ...(typeof data.organization_id === 'string' ? { organization_id: data.organization_id } : {}),
    ...(typeof data.project_id === 'string' ? { project_id: data.project_id } : {}),
    ...(typeof data.mission_id === 'string' ? { mission_id: data.mission_id } : {}),
    ...(typeof data.task_id === 'string' ? { task_id: data.task_id } : {}),
    ...(missionTenant
      ? {
          tenant_slug: missionTenant,
          ...(mission.organization_id ? { organization_id: mission.organization_id } : {}),
          ...(mission.project_id ? { project_id: mission.project_id } : {}),
        }
      : {}),
    tier:
      (missionTenant ? mission.tier : undefined) ||
      (source.tier as EventScope['tier'] | undefined) ||
      mission.tier ||
      'public',
  };
  const tenantSlug =
    typeof candidate.tenant_slug === 'string' ? (candidate.tenant_slug as string) : undefined;
  if (missionTenant && typeof data.tenant_slug === 'string' && data.tenant_slug !== missionTenant) {
    logger.warn(
      `ledger record tenant conflicts with its mission — recorded under the mission's tenant | next: fix the caller's tenant_slug | evidence: mission ${String(data.mission_id)} tenant ${missionTenant}, record tenant ${data.tenant_slug}`
    );
  }
  try {
    return normalizeEventScope(candidate);
  } catch {
    // The system ledger is also used by legacy callers that only know a
    // project or ticket id. Do not fail the business event; narrow the scope
    // (keeping its tenant and mission) rather than inventing a parent
    // tenant/organization, and fall to system only for an untenanted record.
    if (tenantSlug) {
      for (const narrowed of [
        typeof candidate.mission_id === 'string'
          ? { tier: candidate.tier, tenant_slug: tenantSlug, mission_id: candidate.mission_id }
          : undefined,
        { tier: candidate.tier, tenant_slug: tenantSlug },
        // An unplaceable tier never downgrades a tenant record to system.
        { tier: 'confidential', tenant_slug: tenantSlug },
      ]) {
        if (!narrowed) continue;
        try {
          return normalizeEventScope(narrowed as Parameters<typeof normalizeEventScope>[0]);
        } catch {
          /* try the next, narrower scope */
        }
      }
    }
    return normalizeEventScope({ tier: 'public', scope_kind: 'system' });
  }
}

// Legacy support
export const ledger = {
  record,
  verifyIntegrity,
  verifyScopedIntegrity,
  verifyAllLedgerIntegrity,
};
