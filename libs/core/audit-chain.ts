import { createLogger } from './logger.js';
import { isValidTenantSlug } from './entity-scope.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { rootDir } from './path-resolver.js';
import { withLockSync } from './src/lock-utils.js';
export { registerLockIo } from './src/lock-utils.js';
import {
  computeAuditEntryHash,
  GENESIS_HASH,
  getAuditChainKeyId,
  resolveAuditChainKey,
  type ChainAlg,
  verifyAuditEntryHash,
} from './chain-integrity.js';
export { registerChainIntegrityIo } from './chain-integrity.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  parseEventScopeFromRecord,
  type EventScope,
  type EventScopeFilter,
} from './event-scope.js';

const logger = createLogger('audit-chain');

/**
 * Hash-Chained Audit Trail v1.0
 *
 * Keyed hash-chain (HMAC-SHA256) for tamper detection and continuous verification.
 * Note: Off-box notarization and WORM storage are not yet supported.
 */

export interface AuditEntry {
  id: string;
  timestamp: string;
  agentId: string;
  action: string;
  operation: string;
  result: 'allowed' | 'denied' | 'error' | 'completed' | 'failed';
  reason?: string;
  correlationId?: string;
  metadata?: Record<string, any>;
  compliance?: {
    framework: string;
    control: string;
  };
  /**
   * Tenant slug — populated when the active execution is bound to a
   * specific tenant. Used by audit-forwarder filter stages to route
   * tenant-scoped events to per-tenant SIEMs without leakage. Empty /
   * undefined = tenant-agnostic (cross-tenant tooling).
   * Schema-additive: legacy entries without this field remain valid.
   */
  tenantSlug?: string;
  /** Canonical system/tenant/entity scope; tenantSlug is a legacy flat alias. */
  scope?: EventScope;
  chain_alg?: ChainAlg;
  chain_key_id?: string;
  previousHash: string;
  currentHash: string;
}

export interface AuditVerifyOptions {
  since?: string;
}

export interface AuditVerifyResult {
  valid: number;
  corrupted: string[];
  total: number;
  checkedFiles?: string[];
  boundaryLimited?: boolean;
}

/** Secure I/O capabilities supplied by the secure-io boundary. */
export interface AuditChainIo {
  read(filePath: string): string;
  loadJson<T>(filePath: string): T;
  exists(filePath: string): boolean;
  mkdir(dirPath: string): void;
  readdir(dirPath: string): string[];
  append(filePath: string, content: string): void;
}

let auditIo: AuditChainIo | undefined;

function testAuditChainIo(): AuditChainIo | undefined {
  if (!process.env.VITEST) return undefined;
  return (
    globalThis as typeof globalThis & {
      __kyberionVitestIo?: { auditIo?: AuditChainIo };
    }
  ).__kyberionVitestIo?.auditIo;
}
let auditChainInstance: AuditChainImpl | undefined;

/** Install the secure persistence boundary after both modules have initialized. */
export function registerAuditChainIo(io: AuditChainIo): void {
  auditIo = io;
  auditChainInstance?.initializeFromDisk();
}

class AuditChainImpl {
  private lastHash: string = GENESIS_HASH;
  private entryCount: number = 0;
  private auditDir: string;
  private static readonly AUDIT_FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

  constructor() {
    auditIo ||= testAuditChainIo();
    this.auditDir = path.join(pathResolver.rootDir(), 'active', 'shared', 'logs', 'audit');
  }

  initializeFromDisk(): void {
    this.seedFromDisk();
  }

  /**
   * Append a new audit entry to the chain.
   * Auto-populates `tenantSlug` from the active identity context unless
   * the caller has already supplied one.
   */
  record(entry: Omit<AuditEntry, 'id' | 'timestamp' | 'previousHash' | 'currentHash'>): AuditEntry {
    const activeTenantSlug = resolveCurrentTenantSlug();
    if (entry.tenantSlug && activeTenantSlug && entry.tenantSlug !== activeTenantSlug) {
      throw new Error(
        `[AUDIT_SCOPE_DENIED] tenantSlug '${entry.tenantSlug}' conflicts with active tenant '${activeTenantSlug}'`
      );
    }
    if (
      entry.scope?.tenant_slug &&
      activeTenantSlug &&
      entry.scope.tenant_slug !== activeTenantSlug
    ) {
      throw new Error(
        `[AUDIT_SCOPE_DENIED] scope tenant '${entry.scope.tenant_slug}' conflicts with active tenant '${activeTenantSlug}'`
      );
    }
    if (
      entry.tenantSlug &&
      entry.scope?.tenant_slug &&
      entry.tenantSlug !== entry.scope.tenant_slug
    ) {
      throw new Error(
        `[AUDIT_SCOPE_DENIED] tenantSlug and scope.tenant_slug must identify the same tenant`
      );
    }
    if (
      entry.scope &&
      !resolveAuditScope(
        entry.scope,
        entry.scope.tenant_slug ?? entry.tenantSlug ?? activeTenantSlug
      )
    ) {
      throw new Error('[AUDIT_SCOPE_INVALID] explicit audit scope failed validation');
    }
    const fullEntry = withLockSync('audit-chain-global', () => {
      // Refresh the in-memory cursor while holding the inter-process lock;
      // another process may have appended since this module was loaded.
      this.seedFromDisk();
      this.entryCount++;
      const id = `AUD-${Date.now().toString(36).toUpperCase()}-${this.entryCount}`;
      const timestamp = new Date().toISOString();

      const requestedTenantSlug =
        entry.tenantSlug ?? entry.scope?.tenant_slug ?? resolveCurrentTenantSlug();
      const tenantSlug =
        requestedTenantSlug && isValidTenantSlug(requestedTenantSlug)
          ? requestedTenantSlug
          : undefined;
      const chainKey = resolveAuditChainKey({ createIfMissing: true });
      if (!chainKey) throw new Error('missing_audit_chain_key');

      // Do not let an invalid caller-supplied tenantSlug survive through the
      // object spread below. In particular, `public`/`shared` must not remain
      // in the master chain merely because their mirror is skipped.
      const entryWithoutTenantSlug = { ...entry };
      delete entryWithoutTenantSlug.tenantSlug;
      delete entryWithoutTenantSlug.scope;

      const scope = resolveAuditScope(entry.scope, tenantSlug);

      const nextEntry: AuditEntry = {
        id,
        timestamp,
        ...entryWithoutTenantSlug,
        correlationId:
          entry.correlationId ??
          (typeof entry.metadata?.correlationId === 'string'
            ? entry.metadata.correlationId
            : undefined),
        ...(tenantSlug ? { tenantSlug } : {}),
        ...(scope ? { scope } : {}),
        chain_alg: 'hmac-sha256',
        chain_key_id: getAuditChainKeyId(chainKey),
        previousHash: this.lastHash,
        currentHash: '', // computed below
      };

      nextEntry.currentHash = computeAuditEntryHash(
        nextEntry as unknown as Record<string, unknown>,
        this.lastHash,
        {
          alg: 'hmac-sha256',
          key: chainKey,
        }
      );
      this.lastHash = nextEntry.currentHash;

      this.appendToFile(nextEntry);
      return nextEntry;
    });

    // Fan-out to the registered audit forwarder (SIEM / log sink). Dynamic
    // import to keep the forwarder optional and break the circular type
    // dependency (forwarder imports AuditEntry from this module).
    void this.fanOutToForwarder(fullEntry);

    return fullEntry;
  }

  private fanOutToForwarder(entry: AuditEntry): void {
    import('./audit-forwarder.js')
      .then(async ({ getAuditForwarder }) => {
        const forwarder = getAuditForwarder();
        if (forwarder.name === 'stub') return;
        try {
          await forwarder.publish(entry);
        } catch (err: any) {
          logger.warn(
            `[audit-chain] forwarder ${forwarder.name} threw for ${entry.id}: ${err?.message ?? err}`
          );
        }
      })
      .catch((err) => {
        logger.warn(`[audit-chain] failed to load audit-forwarder: ${err?.message ?? err}`);
      });
  }

  /**
   * Record a policy decision.
   */
  recordPolicyDecision(
    agentId: string,
    operation: string,
    result: 'allowed' | 'denied',
    policyName?: string,
    message?: string
  ): AuditEntry {
    return this.record({
      agentId,
      action: 'policy_evaluation',
      operation,
      result,
      reason: message,
      metadata: { policy: policyName },
    });
  }

  /**
   * Record an agent lifecycle event.
   */
  recordLifecycle(
    agentId: string,
    event: 'spawn' | 'shutdown' | 'error' | 'delegation'
  ): AuditEntry {
    return this.record({
      agentId,
      action: 'lifecycle',
      operation: event,
      result: event === 'error' ? 'error' : 'completed',
    });
  }

  /**
   * Record a trust score change.
   */
  recordTrustChange(
    agentId: string,
    oldScore: number,
    newScore: number,
    reason: string
  ): AuditEntry {
    return this.record({
      agentId,
      action: 'trust_update',
      operation: 'score_change',
      result: newScore >= oldScore ? 'completed' : 'failed',
      reason,
      metadata: { oldScore, newScore, delta: newScore - oldScore },
    });
  }

  /**
   * Verify the integrity of the audit chain.
   * Returns the number of valid entries and any corrupted entry IDs.
   */
  verify(options: AuditVerifyOptions = {}): AuditVerifyResult {
    const allFiles = this.listAuditFiles();
    const files = options.since
      ? allFiles.filter((fileName) => {
          const fileDate = this.extractAuditDate(fileName);
          return !fileDate || fileDate >= String(options.since);
        })
      : allFiles;
    const entries = this.loadEntriesFromFiles(files);
    const corrupted: string[] = [];
    let prevHash = GENESIS_HASH;
    let previousFileDate: string | null = null;
    let invalidEntryCount = 0;
    const boundaryLimited = Boolean(options.since);

    for (const fileName of files) {
      const fileDate = this.extractAuditDate(fileName);
      if (fileDate && previousFileDate && !this.isNextUtcDay(previousFileDate, fileDate)) {
        corrupted.push(`audit-gap:${previousFileDate}->${fileDate}`);
      }

      previousFileDate = fileDate ?? previousFileDate;

      for (const entry of this.readAuditFileEntries(path.join(this.auditDir, fileName))) {
        if (boundaryLimited && prevHash === GENESIS_HASH && entry.previousHash !== GENESIS_HASH) {
          prevHash = entry.previousHash;
        }
        const chainAlg = entry.chain_alg ?? 'sha256';
        const chainKey =
          chainAlg === 'hmac-sha256' ? resolveAuditChainKey({ createIfMissing: false }) : null;
        const check = verifyAuditEntryHash(entry as unknown as Record<string, unknown>, prevHash, {
          alg: chainAlg,
          ...(chainKey ? { key: chainKey } : {}),
        });
        if (!check.ok) {
          corrupted.push(entry.id);
          invalidEntryCount++;
        }

        prevHash = entry.currentHash;
      }
    }

    const result = {
      valid: entries.length - invalidEntryCount,
      corrupted,
      total: entries.length,
      checkedFiles: files,
      boundaryLimited,
    };

    if (corrupted.length > 0) {
      logger.error(
        `[AUDIT_CHAIN] Integrity check failed: ${corrupted.length}/${entries.length} entries corrupted`
      );
    } else {
      logger.info(`[AUDIT_CHAIN] Integrity verified: ${entries.length} entries OK`);
    }

    return result;
  }

  /**
   * Verify that tenant mirrors match the master chain exactly (SA-01 Task 4).
   * Checks counts and hashes of mirrored entries against the master record.
   */
  verifyTenantMirrors(): { ok: boolean; findings: string[] } {
    const findings: string[] = [];
    if (!auditIo) return { ok: false, findings: ['audit_io_not_registered'] };
    const masterEntries = this.loadAll();
    const masterByTenant = new Map<string, AuditEntry[]>();

    for (const entry of masterEntries) {
      if (entry.tenantSlug) {
        if (!masterByTenant.has(entry.tenantSlug)) {
          masterByTenant.set(entry.tenantSlug, []);
        }
        masterByTenant.get(entry.tenantSlug)!.push(entry);
      }
    }

    const customersDir = path.join(pathResolver.rootDir(), 'customer');
    if (!auditIo.exists(customersDir)) return { ok: true, findings };

    for (const slug of auditIo.readdir(customersDir)) {
      const mirrorDir = path.join(customersDir, slug, 'logs', 'audit');
      if (!auditIo.exists(mirrorDir)) continue;

      const mirrorFiles = auditIo
        .readdir(mirrorDir)
        .filter((fileName) => AuditChainImpl.AUDIT_FILE_RE.test(fileName))
        .sort((left, right) => left.localeCompare(right));

      const mirrorEntries: AuditEntry[] = [];
      for (const fileName of mirrorFiles) {
        mirrorEntries.push(...this.readAuditFileEntries(path.join(mirrorDir, fileName)));
      }

      const masterSet = masterByTenant.get(slug) || [];
      if (mirrorEntries.length !== masterSet.length) {
        findings.push(
          `tenant_mirror_count_mismatch:${slug} (master=${masterSet.length}, mirror=${mirrorEntries.length})`
        );
      } else {
        for (let i = 0; i < masterSet.length; i++) {
          if (
            masterSet[i].id !== mirrorEntries[i].id ||
            masterSet[i].currentHash !== mirrorEntries[i].currentHash
          ) {
            findings.push(`tenant_mirror_hash_mismatch:${slug}:${masterSet[i].id}`);
            break;
          }
        }
      }
    }

    return {
      ok: findings.length === 0,
      findings,
    };
  }

  /**
   * Load all audit entries from every audit file in chronological order.
   */
  loadAll(): AuditEntry[] {
    return this.loadEntriesFromFiles(this.listAuditFiles());
  }

  /** Read only records visible to an explicit system/entity scope filter. */
  loadForScope(filter: EventScopeFilter): AuditEntry[] {
    return this.loadAll().filter((entry) => {
      const scope = scopeForAuditEntry(entry);
      if (scope === null) return false;
      return eventScopeMatches(scope, filter);
    });
  }

  private loadEntriesFromFiles(files: string[]): AuditEntry[] {
    const entries: AuditEntry[] = [];
    for (const fileName of files) {
      entries.push(...this.readAuditFileEntries(path.join(this.auditDir, fileName)));
    }
    return entries;
  }

  private seedFromDisk(): void {
    if (!auditIo) return;
    const files = this.listAuditFiles();
    if (files.length === 0) return;

    const allEntries = files.flatMap((fileName) =>
      this.readAuditFileEntries(path.join(this.auditDir, fileName))
    );
    if (allEntries.length === 0) return;

    const lastEntry = allEntries[allEntries.length - 1];
    if (lastEntry?.currentHash) {
      this.lastHash = lastEntry.currentHash;
    }
    this.entryCount = allEntries.length;
  }

  private listAuditFiles(): string[] {
    if (!auditIo || !auditIo.exists(this.auditDir)) return [];
    let fileNames: string[];
    try {
      fileNames = auditIo.readdir(this.auditDir);
    } catch (err) {
      // The directory can vanish between the exists check and the readdir
      // (janitor sweeps, tests mocking existsSync). A missing dir simply
      // means no persisted chain yet.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return fileNames
      .filter((fileName) => AuditChainImpl.AUDIT_FILE_RE.test(fileName))
      .sort((left, right) => left.localeCompare(right));
  }

  private extractAuditDate(fileName: string): string | null {
    const match = fileName.match(AuditChainImpl.AUDIT_FILE_RE);
    return match ? match[1] : null;
  }

  private isNextUtcDay(previous: string, current: string): boolean {
    const previousDate = new Date(`${previous}T00:00:00.000Z`);
    if (Number.isNaN(previousDate.getTime())) return true;
    previousDate.setUTCDate(previousDate.getUTCDate() + 1);
    return previousDate.toISOString().slice(0, 10) === current;
  }

  private readAuditFileEntries(filePath: string): AuditEntry[] {
    if (!auditIo || !auditIo.exists(filePath)) return [];
    try {
      const content = auditIo.read(filePath);
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  private appendToFile(entry: AuditEntry): void {
    if (!auditIo) {
      logger.error('[AUDIT_CHAIN] Secure audit I/O is not registered; refusing to persist');
      return;
    }
    try {
      if (!auditIo.exists(this.auditDir)) {
        auditIo.mkdir(this.auditDir);
      }
      auditIo.append(this.getFilePath(), `${JSON.stringify(entry)}\n`);
    } catch (err: any) {
      logger.error(`[AUDIT_CHAIN] Failed to persist: ${err.message}`);
    }

    // Per-tenant mirror: copy to customer/{slug}/logs/audit/ when slug is present.
    //
    // EG-14: the mirror follows an existing stance overlay; it never creates one.
    // `customer/{slug}/` is a stance overlay owned by `pnpm customer:create`, and
    // entity-scope-hierarchy is explicit that "readers must not create missing
    // directories as a side effect; creation belongs to the governed writer".
    // Mirroring used to mkdir -p the whole path, so any audit entry carrying a
    // novel slug — including a test fixture's — materialised a directory that
    // later read back as if a tenant existed. Skipping is lossless: the master
    // chain still holds the entry, and verifyTenantMirrors() skips slugs with no
    // mirror directory, so master and mirror stay consistent.
    if (entry.tenantSlug && isValidTenantSlug(entry.tenantSlug)) {
      try {
        const stanceDir = path.join(rootDir(), 'customer', entry.tenantSlug);
        if (!auditIo.exists(stanceDir)) return;
        const tenantAuditDir = path.join(stanceDir, 'logs', 'audit');
        if (!auditIo.exists(tenantAuditDir)) {
          auditIo.mkdir(tenantAuditDir);
        }
        const date = new Date().toISOString().slice(0, 10);
        auditIo.append(
          path.join(tenantAuditDir, `audit-${date}.jsonl`),
          `${JSON.stringify(entry)}\n`
        );
      } catch (err: any) {
        logger.warn(`[AUDIT_CHAIN] Tenant mirror failed for ${entry.tenantSlug}: ${err.message}`);
      }
    }
  }

  private getFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(this.auditDir, `audit-${date}.jsonl`);
  }
}

function resolveAuditScope(
  scope: EventScope | undefined,
  tenantSlug: string | undefined
): EventScope | undefined {
  try {
    return normalizeEventScope({
      ...(scope || {}),
      ...(tenantSlug && !scope?.tenant_slug ? { tenant_slug: tenantSlug } : {}),
      tier:
        scope?.tier || (getRegisteredEnvText('KYBERION_TIER') as EventScope['tier']) || 'public',
    });
  } catch {
    return undefined;
  }
}

function scopeForAuditEntry(entry: AuditEntry): EventScope | null | undefined {
  const parsedResult = parseEventScopeFromRecord(entry as unknown as Record<string, unknown>);
  if (parsedResult.invalid) return null;
  const parsed = parsedResult.scope;
  if (parsed) return parsed;
  if (entry.scope) return undefined;
  if (entry.tenantSlug && isValidTenantSlug(entry.tenantSlug)) {
    return resolveAuditScope(undefined, entry.tenantSlug);
  }
  return undefined;
}

/**
 * Best-effort tenant slug resolution. Reads `KYBERION_TENANT` env first,
 * falling back to the active mission's `tenant_slug`. Kept synchronous
 * and dependency-free to avoid circular imports with `authority.ts`.
 */
function resolveCurrentTenantSlug(): string | undefined {
  const fromEnv = (getRegisteredEnvText('KYBERION_TENANT') || '').trim();
  // A tier name is syntactically a valid slug, so the shape check alone lets
  // `KYBERION_TENANT=public` through and taints every audit entry it stamps.
  if (fromEnv && isValidTenantSlug(fromEnv)) {
    return fromEnv;
  }
  const missionId = process.env.MISSION_ID;
  if (!missionId) return undefined;
  // Walk up looking for a mission-state.json with tenant_slug.
  const candidates = [
    path.join(pathResolver.rootDir(), 'active/missions/personal', missionId, 'mission-state.json'),
    path.join(
      pathResolver.rootDir(),
      'active/missions/confidential',
      missionId,
      'mission-state.json'
    ),
    path.join(pathResolver.rootDir(), 'active/missions/public', missionId, 'mission-state.json'),
  ];
  for (const candidate of candidates) {
    if (!auditIo || !auditIo.exists(candidate)) continue;
    try {
      const state = auditIo.loadJson<{ tenant_slug?: string }>(candidate);
      const slug = (state.tenant_slug || '').trim();
      if (slug && isValidTenantSlug(slug)) return slug;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

const GLOBAL_KEY = Symbol.for('@kyberion/audit-chain');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new AuditChainImpl();
}
auditChainInstance = (globalThis as any)[GLOBAL_KEY];
export const auditChain: AuditChainImpl = auditChainInstance;
