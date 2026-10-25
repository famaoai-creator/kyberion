import { appendJsonLine, parseSafeJsonInput, readJsonLines } from './foundation/json.js';
import { readTextFile } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeMkdir,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from './secure-io.js';
import { validateReadPermission } from './tier-guard.js';
import { resolveIdentityContext, withExecutionContext } from './authority.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  computeLedgerEntryHash,
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

export const GLOBAL_LEDGER_PATH = pathResolver.resolve('active/audit/system-ledger.jsonl');

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
    if (!tenantSlug) return _writeToLedger(GLOBAL_LEDGER_PATH, entry);
    const tenantPath = tenantLedgerPath(scope.tier, tenantSlug);
    return asTenantLedgerStore(tenantSlug, () => _writeToLedger(tenantPath, entry));
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
      // and a digest of the payload stay for correlation.
      logger.warn(
        `ledger payload withheld — mission id is not placeable by this process | next: record it with an explicit tenant_slug, or from a process that can resolve the mission | evidence: ${type} mission ${String(missionId)}`
      );
      return writeScoped({
        timestamp,
        type,
        scope: unplaceableMissionScope(scope.tier, String(missionId)),
        role: data.role || 'Unknown',
        mission_id: missionId,
        payload_withheld: 'mission_unplaceable',
        payload_digest: createHash('sha256').update(sortedKeyJson(data), 'utf8').digest('hex'),
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
  const detailHash = _writeToLedger(
    safeLedgerPath(path.join(mission.path, 'evidence/ledger.jsonl')),
    detail
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

/** JSON with object keys sorted at every depth (a stable digest input). */
function sortedKeyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
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
 */
function _writeToLedger(ledgerPath: string, entryData: any): string {
  ledgerPath = safeLedgerPath(ledgerPath);
  const lockId = `ledger-${createHash('sha256').update(ledgerPath).digest('hex')}`;
  return withLockSync(lockId, () => {
    const lastHash = _getLastHash(ledgerPath);
    const chainKey = resolveAuditChainKey({ createIfMissing: true });
    if (!chainKey) throw new Error('missing_audit_chain_key');
    const entry: any = {
      ...entryData,
      parent_hash: lastHash,
      chain_alg: 'hmac-sha256' satisfies ChainAlg,
      chain_key_id: getAuditChainKeyId(chainKey),
    };

    const hash = computeLedgerEntryHash(entry, { alg: 'hmac-sha256', key: chainKey });
    entry.hash = hash;

    const dir = path.dirname(ledgerPath);
    if (!safeExistsSync(dir)) {
      safeMkdir(dir, { recursive: true });
    }

    appendJsonLine(ledgerPath, entry);
    return hash;
  });
}

function _getLastHash(ledgerPath: string) {
  ledgerPath = safeLedgerPath(ledgerPath);
  if (!safeExistsSync(ledgerPath)) return GENESIS_HASH;
  ensureRegularLedgerFile(ledgerPath);
  // An existing ledger whose tail cannot be read or parsed must not restart
  // its chain at genesis (that would silently fork it): fail with a
  // diagnostic. record() keeps a metadata-entry failure non-fatal.
  let tailHash: unknown;
  try {
    const trimmed = readTextFile(ledgerPath).trim();
    if (!trimmed) return GENESIS_HASH;
    const lines = trimmed.split('\n');
    const lastEntry = normalizeLedgerRecord(
      parseSafeJsonInput(lines[lines.length - 1], 'ledger tail entry')
    );
    tailHash = lastEntry?.hash;
  } catch (err) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger tail cannot be read — appending would fork its hash chain | next: run pnpm audit:verify and repair the ledger | evidence: ${ledgerPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof tailHash !== 'string' || !tailHash) {
    throw new Error(
      `[LEDGER_TAIL_UNREADABLE] ledger tail entry has no hash — appending would fork its hash chain | next: run pnpm audit:verify and repair the ledger | evidence: ${ledgerPath}`
    );
  }
  return tailHash;
}

export interface LedgerIntegrityReport {
  ok: boolean;
  total: number;
  corrupted: string[];
  missingKey: boolean;
}

/**
 * Verify the integrity of a specific ledger file
 */
export const verifyIntegrity = (ledgerPath: string = GLOBAL_LEDGER_PATH): boolean => {
  return verifyLedgerIntegrityDetailed(ledgerPath).ok;
};

export const verifyLedgerIntegrityDetailed = (
  ledgerPath: string = GLOBAL_LEDGER_PATH
): LedgerIntegrityReport => {
  const safePath = safeLedgerPath(ledgerPath);
  if (!safeExistsSync(safePath)) {
    return { ok: true, total: 0, corrupted: [], missingKey: false };
  }
  ensureRegularLedgerFile(safePath);

  const content = readTextFile(safePath);
  const lines = content.trim().split('\n');
  let expectedParentHash = GENESIS_HASH;
  const corrupted: string[] = [];
  let total = 0;
  let missingKey = false;

  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    total++;
    try {
      const entry = normalizeLedgerRecord(parseSafeJsonInput(line, 'ledger entry'));
      if (!entry) {
        corrupted.push(`line:${index + 1}:invalid_record`);
        continue;
      }
      const chainAlg = (entry.chain_alg ?? 'sha256') as ChainAlg;
      const chainKey =
        chainAlg === 'hmac-sha256' ? resolveAuditChainKey({ createIfMissing: false }) : null;
      const check = verifyLedgerEntryHash(entry, expectedParentHash, {
        alg: chainAlg,
        ...(chainKey ? { key: chainKey } : {}),
      });
      if (!check.ok) {
        if (check.reason === 'missing_audit_chain_key') missingKey = true;
        corrupted.push(
          entry.id ? String(entry.id) : `line:${index + 1}:${check.reason ?? 'invalid'}`
        );
      }
      expectedParentHash = String(entry.hash ?? '');
    } catch (_e) {
      corrupted.push(`line:${index + 1}:parse_error`);
    }
  }
  return {
    ok: corrupted.length === 0,
    total,
    corrupted,
    missingKey,
  };
};

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

/** Every tenant ledger partition file that exists (`<root>/<personal|confidential>/<tenant>/ledger.jsonl`). */
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
        if (safeExistsSync(filePath)) {
          partitions.push({ tier: tier as StorageDataTier, tenant_slug: tenant, path: filePath });
        }
      } catch {
        // A partition this process may not even probe is simply not listed.
      }
    }
  }
  return partitions;
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
  const report = asTenantLedgerStore(tenantSlug, () => verifyLedgerIntegrityDetailed(ledgerPath));
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

function readScopedEntries(safePath: string, filter: EventScopeFilter): Record<string, unknown>[] {
  ensureRegularLedgerFile(safePath);
  return readJsonLines<unknown>(safePath, { onMalformed: 'skip' }).flatMap((value) => {
    try {
      const entry = normalizeLedgerRecord(value);
      if (!entry) return [];
      const scopeResult = resolveScopeForRecord(entry);
      if (scopeResult.disposition === 'invalid') return [];
      const scope = scopeResult.scope;
      return eventScopeMatches(scope, filter) ? [entry] : [];
    } catch {
      return [];
    }
  });
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
 * widened by the filter). An explicit path reads that one file.
 */
export const loadForScope = (
  filter: EventScopeFilter,
  ledgerPath: string = GLOBAL_LEDGER_PATH
): Record<string, unknown>[] => {
  const safePath = safeLedgerPath(ledgerPath);
  const entries = safeExistsSync(safePath) ? readScopedEntries(safePath, filter) : [];
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
      if (!safeExistsSync(partition.path)) continue;
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
