/**
 * QM-02: one governed path for cron, process-watch, and surface wake
 * triggers.
 *
 * A trigger is accepted once, checked against the authority snapshot captured
 * at creation time, and recorded before delivery. A repeated idempotency key
 * therefore returns the original receipt without invoking the delivery
 * callback again.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { auditChain } from './audit-chain.js';
import { resolveRole } from './authority.js';
import { createLogger } from './logger.js';
import { withLock } from './src/lock-utils.js';
import {
  armWatch,
  type ManagedProcessWatchHandle,
  type ManagedProcessWatchOptions,
} from './managed-process.js';

const logger = createLogger('trigger-runner');

export type TriggerSource = 'cron' | 'watch' | 'wake';

export interface TriggerAuthoritySnapshot {
  authority_role: string;
  /** Monotonic authority level captured at trigger creation time. */
  level: number;
  tenant_slug?: string;
}

export interface TriggerRequest {
  idempotencyKey: string;
  source: TriggerSource;
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  payload?: Record<string, unknown>;
}

export interface TriggerDeliveryInput extends TriggerRequest {
  deliveryId: string;
}

export interface TriggerReceipt {
  idempotencyKey: string;
  source: TriggerSource;
  status: 'delivered' | 'failed' | 'rejected' | 'duplicate';
  deliveryId?: string;
  reason?: string;
  recordedAt: string;
}

interface TriggerRecord extends TriggerReceipt {
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  claimId?: string;
  claimOwnerPid?: number;
  claimExpiresAt?: string;
  attempt?: number;
}

export interface TriggerRunnerOptions {
  storePath?: string;
  now?: () => Date;
  claimLeaseMs?: number;
  maxStoreBytes?: number;
  /** Trusted resolver used by governed callers and deterministic tests. */
  authorityResolver?: (authority: TriggerAuthoritySnapshot) => TriggerAuthoritySnapshot;
}

const DEFAULT_STORE_PATH = 'active/shared/runtime/trigger-deliveries.jsonl';
const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 5 * 1024 * 1024;

/** Trigger authority is derived from canonical role scope classes. */
const TRIGGER_SCOPE_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  communication_surface: 20,
  project_delivery: 30,
  quality_validation: 30,
  coordination_runtime: 40,
  operations_runtime: 40,
  mission_state: 50,
  // Audit is orthogonal to trigger execution power and must not elevate it.
  audit: 20,
  knowledge_core: 70,
  security_validation: 70,
  codebase_core: 80,
  design_system: 30,
  personal_identity: 90,
});

function normalizeAuthority(authority: TriggerAuthoritySnapshot): TriggerAuthoritySnapshot {
  const role = String(authority?.authority_role || '').trim();
  const level = Number(authority?.level);
  if (!role) throw new Error('Trigger authority_role is required.');
  if (!Number.isFinite(level) || level < 0) {
    throw new Error('Trigger authority level must be a finite non-negative number.');
  }
  return {
    authority_role: role,
    level,
    ...(authority.tenant_slug?.trim() ? { tenant_slug: authority.tenant_slug.trim() } : {}),
  };
}

type CanonicalAuthorityRole = { role?: string; scope_classes?: string[] };

function readCanonicalAuthorityRole(role: string): CanonicalAuthorityRole | null {
  const rolePath = pathResolver.knowledge(`product/governance/authority-roles/${role}.json`);
  const indexPath = pathResolver.knowledge('product/governance/authority-role-index.json');
  if (safeExistsSync(rolePath)) {
    try {
      const record = JSON.parse(
        safeReadFile(rolePath, { encoding: 'utf8' }) as string
      ) as CanonicalAuthorityRole;
      if (record.role === role) return record;
    } catch {
      // Fall through to the synchronized role index.
    }
  }
  if (safeExistsSync(indexPath)) {
    try {
      const index = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string) as {
        authority_roles?: Record<string, CanonicalAuthorityRole>;
      };
      const record = index.authority_roles?.[role];
      if (record) return { role, ...record };
    } catch {
      // Fail closed below.
    }
  }
  return null;
}

function governedTriggerLevel(role: string): number | undefined {
  const record = readCanonicalAuthorityRole(role);
  if (!record) return undefined;
  const levels = (record.scope_classes || [])
    .map((scope) => TRIGGER_SCOPE_LEVELS[scope])
    .filter((level): level is number => level !== undefined);
  return levels.length > 0 ? Math.max(...levels) : undefined;
}

function assertCanonicalAuthorityRole(role: string): void {
  if (!readCanonicalAuthorityRole(role)) {
    throw new Error(`[POLICY_VIOLATION] Unknown trigger authority role: ${role}`);
  }
}

function resolveGovernedAuthority(authority: TriggerAuthoritySnapshot): TriggerAuthoritySnapshot {
  const normalized = normalizeAuthority(authority);
  assertCanonicalAuthorityRole(normalized.authority_role);
  const governedLevel = governedTriggerLevel(normalized.authority_role);
  if (governedLevel === undefined) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority role has no governed level: ${normalized.authority_role}`
    );
  }
  if (normalized.level !== governedLevel) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority level does not match role registry: role=${normalized.authority_role} expected=${governedLevel} received=${normalized.level}`
    );
  }
  const activeRole = process.env.MISSION_ROLE?.trim() || resolveRole();
  if (activeRole && activeRole !== normalized.authority_role) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority is not bound to the active execution role: active=${activeRole} requested=${normalized.authority_role}`
    );
  }
  if (!activeRole) {
    throw new Error('[AUTHORITY_UNBOUND] Trigger execution requires an active MISSION_ROLE.');
  }
  return normalized;
}

/** Reject a trigger whose requested authority exceeds its creator snapshot. */
export function assertNoEscalation(
  createdBy: TriggerAuthoritySnapshot,
  requestedAuthority: TriggerAuthoritySnapshot = createdBy
): void {
  const creator = normalizeAuthority(createdBy);
  const requested = normalizeAuthority(requestedAuthority);
  for (const authority of [creator, requested]) {
    assertCanonicalAuthorityRole(authority.authority_role);
    const governedLevel = governedTriggerLevel(authority.authority_role);
    if (governedLevel === undefined || authority.level !== governedLevel) {
      throw new Error(
        `[POLICY_VIOLATION] Trigger authority level does not match role registry: role=${authority.authority_role} expected=${governedLevel ?? 'registered level'} received=${authority.level}`
      );
    }
  }
  if (requested.level > creator.level) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority escalation denied: creator=${creator.authority_role}:${creator.level} requested=${requested.authority_role}:${requested.level}`
    );
  }
  if (
    creator.tenant_slug &&
    requested.tenant_slug &&
    creator.tenant_slug !== requested.tenant_slug
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger tenant scope escalation denied: creator=${creator.tenant_slug} requested=${requested.tenant_slug}`
    );
  }
}

function readRecords(storePath: string): TriggerRecord[] {
  if (!safeExistsSync(storePath)) return [];
  const raw = safeReadFile(storePath, { encoding: 'utf8', maxSizeMB: 5 }) as string;
  const records: TriggerRecord[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TriggerRecord;
      if (parsed && typeof parsed.idempotencyKey === 'string') records.push(parsed);
    } catch {
      // A torn record must not erase the valid history before it.
    }
  }
  return records;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function compactRecords(storePath: string, records: TriggerRecord[]): void {
  const latest = new Map<string, TriggerRecord>();
  for (const record of records) latest.set(record.idempotencyKey, record);
  const serialized = [...latest.values()].map((record) => JSON.stringify(record)).join('\n');
  safeWriteFile(storePath, serialized ? `${serialized}\n` : '');
}

function appendRecord(storePath: string, record: TriggerRecord, maxStoreBytes: number): void {
  safeMkdir(path.dirname(pathResolver.rootResolve(storePath)));
  const serialized = `${JSON.stringify(record)}\n`;
  let size = 0;
  if (safeExistsSync(storePath)) {
    try {
      size = safeStat(storePath).size;
    } catch {
      size = 0;
    }
  }
  if (size + Buffer.byteLength(serialized, 'utf8') > maxStoreBytes) {
    compactRecords(storePath, readRecords(storePath));
  }
  safeAppendFileSync(storePath, serialized);
}

function recordTriggerAudit(record: TriggerRecord): void {
  try {
    auditChain.record({
      agentId: record.createdBy.authority_role,
      action: `trigger.${record.status}`,
      operation: `${record.source}:${record.idempotencyKey}`,
      result:
        record.status === 'delivered'
          ? 'completed'
          : record.status === 'rejected'
            ? 'denied'
            : record.status === 'failed'
              ? 'error'
              : 'allowed',
      reason: record.reason,
      correlationId: record.idempotencyKey,
      tenantSlug: record.createdBy.tenant_slug,
      metadata: {
        requested_authority: record.requestedAuthority,
        delivery_id: record.deliveryId,
      },
    });
  } catch (error) {
    // Audit availability must not rewrite a completed side effect as failed.
    logger.error(
      `[TRIGGER_AUDIT_FAILED] ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function receiptFrom(record: TriggerRecord, status: TriggerReceipt['status']): TriggerReceipt {
  return {
    idempotencyKey: record.idempotencyKey,
    source: record.source,
    status,
    ...(record.deliveryId ? { deliveryId: record.deliveryId } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    recordedAt: record.recordedAt,
  };
}

export class TriggerRunner {
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly claimLeaseMs: number;
  private readonly maxStoreBytes: number;
  private readonly authorityResolver: (
    authority: TriggerAuthoritySnapshot
  ) => TriggerAuthoritySnapshot;
  private readonly lockId: string;

  constructor(options: TriggerRunnerOptions = {}) {
    this.storePath = options.storePath || DEFAULT_STORE_PATH;
    this.now = options.now || (() => new Date());
    this.claimLeaseMs = Math.max(1000, options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS);
    this.maxStoreBytes = Math.max(
      64 * 1024,
      Math.min(options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES, MAX_STORE_BYTES)
    );
    this.authorityResolver = options.authorityResolver || resolveGovernedAuthority;
    this.lockId = `trigger-store-${createHash('sha256')
      .update(pathResolver.rootResolve(this.storePath))
      .digest('hex')
      .slice(0, 32)}`;
  }

  records(): TriggerReceipt[] {
    return readRecords(this.storePath).map((record) => receiptFrom(record, record.status));
  }

  async run(
    request: TriggerRequest,
    deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>
  ): Promise<TriggerReceipt> {
    const idempotencyKey = String(request.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new Error('Trigger idempotencyKey is required.');
    if (!request.source) throw new Error('Trigger source is required.');
    const claim = await withLock(this.lockId, async () => {
      const existing = readRecords(this.storePath)
        .reverse()
        .find((record) => record.idempotencyKey === idempotencyKey);
      if (existing) {
        const pendingUntil = existing.claimExpiresAt ? Date.parse(existing.claimExpiresAt) : 0;
        const pending = existing.reason === 'delivery_pending';
        const terminal = existing.status === 'delivered' || existing.status === 'rejected';
        const ownerAlive = pending && isProcessAlive(existing.claimOwnerPid);
        if (terminal || (pending && (pendingUntil > this.now().getTime() || ownerAlive))) {
          return { receipt: receiptFrom(existing, 'duplicate') };
        }
      }

      const rawCreatedBy = normalizeAuthority(request.createdBy);
      const rawRequestedAuthority = normalizeAuthority(request.requestedAuthority || rawCreatedBy);
      let createdBy = rawCreatedBy;
      let requestedAuthority = rawRequestedAuthority;
      let base: TriggerRecord = {
        idempotencyKey,
        source: request.source,
        status: 'rejected',
        createdBy,
        requestedAuthority,
        recordedAt: this.now().toISOString(),
      };

      try {
        createdBy = this.authorityResolver(rawCreatedBy);
        requestedAuthority = this.authorityResolver(rawRequestedAuthority);
        assertNoEscalation(createdBy, requestedAuthority);
        base = { ...base, createdBy, requestedAuthority };
      } catch (error) {
        const rejected: TriggerRecord = {
          ...base,
          status: 'rejected',
          reason: error instanceof Error ? error.message : String(error),
        };
        appendRecord(this.storePath, rejected, this.maxStoreBytes);
        recordTriggerAudit(rejected);
        return { receipt: receiptFrom(rejected, 'rejected') };
      }

      const claimed: TriggerRecord = {
        ...base,
        status: 'failed',
        reason: 'delivery_pending',
        deliveryId: idempotencyKey,
        claimId: randomUUID(),
        claimOwnerPid: process.pid,
        claimExpiresAt: new Date(this.now().getTime() + this.claimLeaseMs).toISOString(),
        attempt: ((existing?.attempt as number | undefined) || 0) + 1,
      };
      appendRecord(this.storePath, claimed, this.maxStoreBytes);
      return { claimed };
    });

    if ('receipt' in claim) return claim.receipt;
    const { claimed } = claim;

    try {
      const deliveryId =
        (await deliver({
          ...request,
          idempotencyKey,
          createdBy: claimed.createdBy,
          requestedAuthority: claimed.requestedAuthority,
          deliveryId: idempotencyKey,
        })) || idempotencyKey;
      const delivered: TriggerRecord = {
        ...claimed,
        status: 'delivered',
        deliveryId,
        reason: undefined,
        recordedAt: this.now().toISOString(),
      };
      await withLock(this.lockId, async () => {
        appendRecord(this.storePath, delivered, this.maxStoreBytes);
      });
      recordTriggerAudit(delivered);
      return receiptFrom(delivered, 'delivered');
    } catch (error) {
      const failed: TriggerRecord = {
        ...claimed,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        recordedAt: this.now().toISOString(),
      };
      await withLock(this.lockId, async () => {
        appendRecord(this.storePath, failed, this.maxStoreBytes);
      });
      recordTriggerAudit(failed);
      return receiptFrom(failed, 'failed');
    }
  }
}

export function createTriggerRunner(options: TriggerRunnerOptions = {}): TriggerRunner {
  return new TriggerRunner(options);
}

/** Run one scheduler tick under an inter-process leader lease. */
export async function withTriggerLeaderLease<T>(
  leaderId: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await withLock(`trigger-leader-${leaderId.replace(/[^a-zA-Z0-9_-]/gu, '_')}`, fn, 1);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[LOCK_TIMEOUT]')) return undefined;
    throw error;
  }
}

export interface TriggerWatchOptions extends Omit<ManagedProcessWatchOptions, 'onEvent'> {
  runner?: TriggerRunner;
  idempotencyPrefix: string;
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>;
}

/** Bridge managed-process watch events into the same trigger runner. */
export function armTriggerWatch(
  resourceId: string,
  options: TriggerWatchOptions
): ManagedProcessWatchHandle {
  const runner = options.runner || createTriggerRunner();
  const {
    runner: _runner,
    idempotencyPrefix,
    createdBy,
    requestedAuthority,
    deliver,
    ...watch
  } = options;
  return armWatch(resourceId, {
    ...watch,
    onEvent: async (event) => {
      const key = `${idempotencyPrefix}:${event.kind}:${event.at}`;
      await runner.run(
        {
          idempotencyKey: key,
          source: 'watch',
          createdBy,
          requestedAuthority,
          payload: {
            resource_id: event.resourceId,
            event: event.kind,
            tail: event.tail,
          },
        },
        deliver
      );
    },
  });
}

/** Explicit surface wake entry point; it intentionally shares TriggerRunner. */
export function runWakeTrigger(
  runner: TriggerRunner,
  request: Omit<TriggerRequest, 'source'>,
  deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>
): Promise<TriggerReceipt> {
  return runner.run({ ...request, source: 'wake' }, deliver);
}
