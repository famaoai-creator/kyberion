import { logger } from './core.js';
import { safeReadFile, safeWriteFile, safeAppendFileSync, safeExistsSync, safeMkdir } from './secure-io.js';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';

/**
 * Hash-Chained Audit Trail v1.0
 *
 * Append-only, tamper-evident audit log with SHA-256 hash chain.
 * Each entry includes the hash of the previous entry for integrity verification.
 */

export interface AuditEntry {
  id: string;
  timestamp: string;
  agentId: string;
  action: string;
  operation: string;
  result: 'allowed' | 'denied' | 'error' | 'completed' | 'failed';
  reason?: string;
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
  previousHash: string;
  currentHash: string;
}

class AuditChainImpl {
  private lastHash: string = '0000000000000000000000000000000000000000000000000000000000000000';
  private entryCount: number = 0;
  private auditDir: string;

  constructor() {
    this.auditDir = path.join(pathResolver.rootDir(), 'active', 'audit');
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

    const fullEntry: AuditEntry = {
      id,
      timestamp,
      ...entry,
      ...(tenantSlug ? { tenantSlug } : {}),
      previousHash: this.lastHash,
      currentHash: '', // computed below
    };

    // Compute hash: SHA-256(previousHash + serialized entry)
    const hashInput = this.lastHash + JSON.stringify({ ...fullEntry, currentHash: undefined });
    fullEntry.currentHash = createHash('sha256').update(hashInput).digest('hex');
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
          logger.warn(`[audit-chain] forwarder ${forwarder.name} threw for ${entry.id}: ${err?.message ?? err}`);
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
  recordLifecycle(agentId: string, event: 'spawn' | 'shutdown' | 'error' | 'delegation'): AuditEntry {
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
  recordTrustChange(agentId: string, oldScore: number, newScore: number, reason: string): AuditEntry {
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
  verify(): { valid: number; corrupted: string[]; total: number } {
    const entries = this.loadAll();
    const corrupted: string[] = [];
    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';

    for (const entry of entries) {
      if (entry.previousHash !== prevHash) {
        corrupted.push(entry.id);
        continue;
      }

      const hashInput = prevHash + JSON.stringify({ ...entry, currentHash: undefined });
      const expectedHash = createHash('sha256').update(hashInput).digest('hex');

      if (entry.currentHash !== expectedHash) {
        corrupted.push(entry.id);
      }

      prevHash = entry.currentHash;
    }

    const result = {
      valid: entries.length - corrupted.length,
      corrupted,
      total: entries.length,
    };

    if (corrupted.length > 0) {
      logger.error(`[AUDIT_CHAIN] Integrity check failed: ${corrupted.length}/${entries.length} entries corrupted`);
    } else {
      logger.info(`[AUDIT_CHAIN] Integrity verified: ${entries.length} entries OK`);
    }

    return result;
  }

  /**
   * Load all audit entries from the current day's file.
   */
  loadAll(): AuditEntry[] {
    const filePath = this.getFilePath();
    if (!safeExistsSync(filePath)) return [];

    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
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
    path.join(pathResolver.rootDir(), 'active/missions/confidential', missionId, 'mission-state.json'),
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
