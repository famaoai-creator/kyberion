import { logger } from './core.js';
import {
  safeReadFile,
  safeWriteFile,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
} from './secure-io.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { rootDir } from './path-resolver.js';
import {
  computeAuditEntryHash,
  GENESIS_HASH,
  getAuditChainKeyId,
  resolveAuditChainKey,
  type ChainAlg,
  verifyAuditEntryHash,
} from './chain-integrity.js';

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

class AuditChainImpl {
  private lastHash: string = GENESIS_HASH;
  private entryCount: number = 0;
  private auditDir: string;
  private static readonly AUDIT_FILE_RE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

  constructor() {
    this.auditDir = path.join(pathResolver.rootDir(), 'active', 'shared', 'logs', 'audit');
    this.seedFromDisk();
  }

  /**
   * Append a new audit entry to the chain.
   * Auto-populates `tenantSlug` from the active identity context unless
   * the caller has already supplied one.
   */
  record(entry: Omit<AuditEntry, 'id' | 'timestamp' | 'previousHash' | 'currentHash'>): AuditEntry {
    this.entryCount++;
    const id = `AUD-${Date.now().toString(36).toUpperCase()}-${this.entryCount}`;
    const timestamp = new Date().toISOString();

    const tenantSlug = entry.tenantSlug ?? resolveCurrentTenantSlug();
    const chainKey = resolveAuditChainKey({ createIfMissing: true });
    if (!chainKey) throw new Error('missing_audit_chain_key');

    const fullEntry: AuditEntry = {
      id,
      timestamp,
      ...entry,
      correlationId:
        entry.correlationId ??
        (typeof entry.metadata?.correlationId === 'string'
          ? entry.metadata.correlationId
          : undefined),
      ...(tenantSlug ? { tenantSlug } : {}),
      chain_alg: 'hmac-sha256',
      chain_key_id: getAuditChainKeyId(chainKey),
      previousHash: this.lastHash,
      currentHash: '', // computed below
    };

    fullEntry.currentHash = computeAuditEntryHash(
      fullEntry as unknown as Record<string, unknown>,
      this.lastHash,
      {
        alg: 'hmac-sha256',
        key: chainKey,
      }
    );
    this.lastHash = fullEntry.currentHash;

    // Persist
    this.appendToFile(fullEntry);

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
    if (!safeExistsSync(customersDir)) return { ok: true, findings };

    for (const slug of safeReaddir(customersDir)) {
      const mirrorDir = path.join(customersDir, slug, 'logs', 'audit');
      if (!safeExistsSync(mirrorDir)) continue;

      const mirrorFiles = safeReaddir(mirrorDir)
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

  private loadEntriesFromFiles(files: string[]): AuditEntry[] {
    const entries: AuditEntry[] = [];
    for (const fileName of files) {
      entries.push(...this.readAuditFileEntries(path.join(this.auditDir, fileName)));
    }
    return entries;
  }

  private seedFromDisk(): void {
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
    if (!safeExistsSync(this.auditDir)) return [];
    let fileNames: string[];
    try {
      fileNames = safeReaddir(this.auditDir);
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
    if (!safeExistsSync(filePath)) return [];
    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
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
    try {
      if (!safeExistsSync(this.auditDir)) {
        safeMkdir(this.auditDir, { recursive: true });
      }
      safeAppendFileSync(this.getFilePath(), JSON.stringify(entry) + '\n');
    } catch (err: any) {
      logger.error(`[AUDIT_CHAIN] Failed to persist: ${err.message}`);
    }

    // Per-tenant mirror: copy to customer/{slug}/logs/audit/ when slug is present.
    if (entry.tenantSlug) {
      try {
        const tenantAuditDir = path.join(rootDir(), 'customer', entry.tenantSlug, 'logs', 'audit');
        if (!safeExistsSync(tenantAuditDir)) {
          safeMkdir(tenantAuditDir, { recursive: true });
        }
        const date = new Date().toISOString().slice(0, 10);
        safeAppendFileSync(
          path.join(tenantAuditDir, `audit-${date}.jsonl`),
          JSON.stringify(entry) + '\n'
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

/**
 * Best-effort tenant slug resolution. Reads `KYBERION_TENANT` env first,
 * falling back to the active mission's `tenant_slug`. Kept synchronous
 * and dependency-free to avoid circular imports with `authority.ts`.
 */
function resolveCurrentTenantSlug(): string | undefined {
  const fromEnv = (process.env.KYBERION_TENANT || '').trim();
  if (fromEnv && /^[a-z][a-z0-9-]{1,30}$/.test(fromEnv)) return fromEnv;
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
    if (!safeExistsSync(candidate)) continue;
    try {
      const state = JSON.parse(safeReadFile(candidate, { encoding: 'utf8' }) as string);
      const slug = (state.tenant_slug || '').trim();
      if (slug && /^[a-z][a-z0-9-]{1,30}$/.test(slug)) return slug;
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
export const auditChain: AuditChainImpl = (globalThis as any)[GLOBAL_KEY];
