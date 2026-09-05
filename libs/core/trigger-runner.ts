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
import { parseSafeJsonInput } from './foundation/json.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { clamp, isRecord } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { loadAuthorityRoleIndex } from './authority-role-registry.js';
import { auditChain } from './audit-chain.js';
import { resolveRole } from './authority.js';
import { createLogger } from './logger.js';
import { withLock } from './src/lock-utils.js';
import {
  armWatch,
  type ManagedProcessWatchHandle,
  type ManagedProcessWatchOptions,
} from './managed-process.js';
import { withTriggerCorrelation } from './trigger-correlation.js';

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
  try {
    const record = loadAuthorityRoleIndex()[role];
    if (record) return { role, ...record };
  } catch {
    // Fail closed below when the role directory and snapshot are invalid.
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
  const activeRole = getRegisteredEnvText('MISSION_ROLE')?.trim() || resolveRole();
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

/**
 * EV-02: the authority snapshot of the currently active execution role.
 *
 * Callers that run under a varying role (a provider session booted by whichever
 * role asked for it) cannot hardcode `{authority_role, level}` — and a hardcoded
 * level that drifts from the role registry is rejected outright. Derive both
 * from the registry instead, so the snapshot is true by construction.
 *
 * Throws when no role is bound, because an unattributable trigger must not run.
 */
export function resolveCurrentTriggerAuthority(tenantSlug?: string): TriggerAuthoritySnapshot {
  const activeRole = getRegisteredEnvText('MISSION_ROLE')?.trim() || resolveRole();
  if (!activeRole) {
    throw new Error('[AUTHORITY_UNBOUND] Trigger execution requires an active MISSION_ROLE.');
  }
  assertCanonicalAuthorityRole(activeRole);
  const level = governedTriggerLevel(activeRole);
  if (level === undefined) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority role has no governed level: ${activeRole}`
    );
  }
  // The `as` cast is gone deliberately: it was hiding a misspelled property
  // (`tenantSlug` instead of the declared `tenant_slug`), so the tenant scope
  // silently never reached the snapshot. Let the object be checked structurally.
  return {
    authority_role: activeRole,
    level,
    ...(tenantSlug?.trim() ? { tenant_slug: tenantSlug.trim() } : {}),
  };
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

function persistedRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function persistedAuthority(value: unknown): TriggerAuthoritySnapshot | null {
  if (!isRecord(value)) return null;
  const authorityRole = persistedRequiredString(value.authority_role);
  const level = value.level;
  if (authorityRole === null || typeof level !== 'number' || !Number.isFinite(level) || level < 0) {
    return null;
  }
  if (value.tenant_slug !== undefined && typeof value.tenant_slug !== 'string') return null;
  return {
    authority_role: authorityRole,
    level,
    ...(typeof value.tenant_slug === 'string' && value.tenant_slug.trim()
      ? { tenant_slug: value.tenant_slug }
      : {}),
  };
}

/** Normalize one persisted receipt before it participates in idempotency state. */
export function normalizeTriggerRecord(value: unknown): TriggerRecord | null {
  if (!isRecord(value)) return null;
  const idempotencyKey = persistedRequiredString(value.idempotencyKey);
  const recordedAt = persistedRequiredString(value.recordedAt);
  const source = value.source;
  const status = value.status;
  const createdBy = persistedAuthority(value.createdBy);
  if (
    idempotencyKey === null ||
    recordedAt === null ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    (source !== 'cron' && source !== 'watch' && source !== 'wake') ||
    (status !== 'delivered' &&
      status !== 'failed' &&
      status !== 'rejected' &&
      status !== 'duplicate') ||
    createdBy === null
  ) {
    return null;
  }

  const requestedAuthority =
    value.requestedAuthority === undefined
      ? undefined
      : persistedAuthority(value.requestedAuthority);
  if (value.requestedAuthority !== undefined && requestedAuthority === null) return null;

  for (const field of ['deliveryId', 'reason', 'claimId', 'claimExpiresAt'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null;
  }
  const claimExpiresAt = value.claimExpiresAt;
  if (typeof claimExpiresAt === 'string' && !Number.isFinite(Date.parse(claimExpiresAt))) {
    return null;
  }
  for (const field of ['claimOwnerPid', 'attempt'] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== 'number' || !Number.isInteger(value[field]) || value[field] < 0)
    ) {
      return null;
    }
  }

  return {
    idempotencyKey,
    source,
    status,
    createdBy,
    ...(requestedAuthority ? { requestedAuthority } : {}),
    ...(typeof value.deliveryId === 'string' ? { deliveryId: value.deliveryId } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    recordedAt,
    ...(typeof value.claimId === 'string' ? { claimId: value.claimId } : {}),
    ...(typeof value.claimOwnerPid === 'number' ? { claimOwnerPid: value.claimOwnerPid } : {}),
    ...(typeof claimExpiresAt === 'string' ? { claimExpiresAt } : {}),
    ...(typeof value.attempt === 'number' ? { attempt: value.attempt } : {}),
  };
}

function readRecords(storePath: string): TriggerRecord[] {
  if (!safeExistsSync(storePath)) return [];
  const raw = safeReadFile(storePath, { encoding: 'utf8', maxSizeMB: 5 }) as string;
  const records: TriggerRecord[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = parseSafeJsonInput(line, 'trigger record');
      const record = normalizeTriggerRecord(parsed);
      if (record) records.push(record);
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
    this.storePath = assertSafeRepositoryPath(
      pathResolver.rootResolve(options.storePath || DEFAULT_STORE_PATH),
      { allowMissingLeaf: true }
    );
    this.now = options.now || (() => new Date());
    this.claimLeaseMs = Math.max(1000, options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS);
    this.maxStoreBytes = clamp(
      options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES,
      64 * 1024,
      MAX_STORE_BYTES
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
      // EV-09: everything this delivery causes runs inside the correlation
      // scope, so worker events and operator notifications can attribute
      // themselves to this firing without a threaded parameter.
      const deliveryId =
        (await withTriggerCorrelation(
          { deliveryId: idempotencyKey, source: request.source, idempotencyKey },
          () =>
            deliver({
              ...request,
              idempotencyKey,
              createdBy: claimed.createdBy,
              requestedAuthority: claimed.requestedAuthority,
              deliveryId: idempotencyKey,
            })
        )) || idempotencyKey;
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
