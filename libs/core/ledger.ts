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
import { withExecutionContext } from './authority.js';
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
 * `active/shared/runtime/tenant-ledger/<tier>/<tenant>/ledger.jsonl`, as the
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

/** Absolute path of one tenant's ledger partition (`<root>/<tier>/<tenant>/ledger.jsonl`). */
export function tenantLedgerPath(tier: StorageDataTier, tenantSlug: string): string {
  if (!isValidTenantSlug(tenantSlug)) {
    throw new Error(`[LEDGER_TENANT_INVALID] '${tenantSlug}' is not a tenant slug`);
  }
  return pathResolver.resolve(
    path.posix.join(
      TENANT_LEDGER_ROOT,
      ...storagePartitionSegments({ kind: 'tier', tier, tenant: tenantSlug }),
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

  // 1. Locate the mission: its state and location are the scope authority.
  let missionPath: string | null = null;
  if (missionId && missionId !== 'None') {
    missionPath = (pathResolver as any).findMissionPath(missionId);
  }
  const scope = resolveLedgerScope(data, missionPath ? missionLedgerScope(missionPath) : {});
  const tenantSlug = scope.tenant_slug;
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

  // 2. Without a mission ledger the detailed entry goes to the scoped ledger:
  //    the tenant's partition, or the system ledger for an untenanted record.
  if (!missionPath) return writeScoped(detail);

  // 3. Detailed entry in the mission's evidence ledger; metadata entry in the
  //    scoped ledger (never the system ledger for a tenant mission).
  const detailHash = _writeToLedger(
    safeLedgerPath(path.join(missionPath, 'evidence/ledger.jsonl')),
    detail
  );
  writeScoped({
    timestamp,
    type: `MISSION_EVENT:${type}`,
    scope,
    role: data.role || 'Unknown',
    mission_id: missionId,
    detail_hash: detailHash, // Link to the detailed ledger
    note: 'Metadata only. See mission evidence for details.',
  });
  return detailHash;
};

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
 * Scope of a mission from its state (authoritative) and its location. An
 * unreadable state leaves the location's answer; nothing here invents a tenant.
 */
function missionLedgerScope(missionPath: string): MissionLedgerScope {
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
  const stateTenant = nestedString(state, 'tenant_slug');
  const tenant = stateTenant && isValidTenantSlug(stateTenant) ? stateTenant : locatedTenant;
  const tier = stateTier || locatedTier;
  const organization =
    nestedString(state, 'organization_id') ||
    nestedString(state, 'relationships', 'organization', 'organization_id');
  const project = nestedString(state, 'relationships', 'project', 'project_id');
  return {
    ...(tier ? { tier } : {}),
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(tenant && organization ? { organization_id: organization } : {}),
    ...(tenant && organization && project ? { project_id: project } : {}),
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
  try {
    const content = readTextFile(ledgerPath);
    const trimmed = content.trim();
    if (!trimmed) return GENESIS_HASH;
    const lines = trimmed.split('\n');
    const lastEntry = normalizeLedgerRecord(
      parseSafeJsonInput(lines[lines.length - 1], 'ledger tail entry')
    );
    return lastEntry?.hash || GENESIS_HASH;
  } catch (_e) {
    return GENESIS_HASH;
  }
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

/** Every tenant ledger partition file that exists (`<root>/<tier>/<tenant>/ledger.jsonl`). */
export function listTenantLedgerPartitions(): TenantLedgerPartition[] {
  const root = pathResolver.resolve(TENANT_LEDGER_ROOT);
  const partitions: TenantLedgerPartition[] = [];
  for (const tier of listDirectory(root)) {
    if (!STORAGE_DATA_TIERS.includes(tier as StorageDataTier)) continue;
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
  return { ...report, path: ledgerPath, tier, tenant_slug: tenantSlug };
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
        `tenant ledger verification skipped — this process may not bind the tenant | next: verify from an unbound operator process or as that tenant | evidence: ${partition.tier}/${partition.tenant_slug}: ${err instanceof Error ? err.message : String(err)}`
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
            ? STORAGE_DATA_TIERS.map((tier) => ({
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
