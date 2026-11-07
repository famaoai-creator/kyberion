/**
 * Zero-dependency seam between secure-io and the governance recording modules
 * (audit-chain, governance-action-recorder, chain-integrity, lock-utils).
 *
 * Why this exists: secure-io sits on every file's import path, so every module
 * it statically imports rides along into every process. The audit pipeline is
 * observability, not an authorization decision — deferrable records are
 * explicitly best-effort — so the dependency direction is inverted here:
 * recording modules register themselves (and their I/O consumers) when they
 * load, and secure-io only talks to this registry. A process that never loads
 * the audit modules simply keeps pending records buffered (bounded) and
 * flushes them if a recorder arrives; if none ever does, the records are
 * dropped the same way governance-action-recorder already drops them when no
 * sink is installed.
 *
 * Ordering is symmetric in both directions: whichever side registers second
 * (provider or consumer) triggers the connection at registration time, so
 * module-load order never changes the outcome.
 */

/** Deferrable audit record as submitted by secure-io denial/write paths. */
export interface DeferrableAuditRecord {
  agentId: string;
  action: string;
  operation: string;
  result: 'allowed' | 'denied' | 'error' | 'completed' | 'failed';
  reason?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  tenantSlug?: string;
}

/** Governance-action denial report (matches GovernanceActionRecord). */
export interface GovernanceDenialRecord {
  agentId: string;
  operation: string;
  reason: string;
  policyViolation: boolean;
}

export type DeferrableAuditRecorder = (record: DeferrableAuditRecord) => unknown;
export type GovernanceActionRecorder = (record: GovernanceDenialRecord) => void;
export type AuditIoConsumer = (io: unknown) => void;

const MAX_PENDING_RECORDS = 256;

interface AuditSinkRegistry {
  auditRecorder?: DeferrableAuditRecorder;
  governanceRecorder?: GovernanceActionRecorder;
  pendingAudit: DeferrableAuditRecord[];
  pendingGovernance: GovernanceDenialRecord[];
  auditIoChannels: Map<string, { io?: unknown; consumers: AuditIoConsumer[] }>;
}

const REGISTRY_KEY = Symbol.for('kyberion.deferrable-audit-sink');

function registry(): AuditSinkRegistry {
  const globals = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: AuditSinkRegistry;
  };
  return (globals[REGISTRY_KEY] ??= {
    pendingAudit: [],
    pendingGovernance: [],
    auditIoChannels: new Map(),
  });
}

function enqueue<T>(pending: T[], record: T): void {
  if (pending.length >= MAX_PENDING_RECORDS) pending.shift();
  pending.push(record);
}

/**
 * Installed by the audit-chain module when it loads. Queued records flush in
 * submission order; a faulty recorder must never throw into the audited op.
 */
export function registerDeferrableAuditRecorder(recorder: DeferrableAuditRecorder): void {
  const reg = registry();
  reg.auditRecorder = recorder;
  const pending = reg.pendingAudit.splice(0, reg.pendingAudit.length);
  for (const record of pending) {
    try {
      recorder(record);
    } catch {
      /* deferrable audit must never fail the audited operation */
    }
  }
}

/** secure-io's only hook for deferrable audit: best-effort, never throws. */
export function recordDeferrableAudit(record: DeferrableAuditRecord): void {
  const reg = registry();
  if (!reg.auditRecorder) {
    enqueue(reg.pendingAudit, record);
    return;
  }
  try {
    reg.auditRecorder(record);
  } catch {
    /* deferrable audit must never fail the audited operation */
  }
}

export function registerGovernanceActionRecorder(recorder: GovernanceActionRecorder): void {
  const reg = registry();
  reg.governanceRecorder = recorder;
  const pending = reg.pendingGovernance.splice(0, reg.pendingGovernance.length);
  for (const record of pending) {
    try {
      recorder(record);
    } catch {
      /* a recorder fault must not fail the operation being audited */
    }
  }
}

export function recordGovernanceActionReport(record: GovernanceDenialRecord): void {
  const reg = registry();
  if (!reg.governanceRecorder) {
    enqueue(reg.pendingGovernance, record);
    return;
  }
  try {
    reg.governanceRecorder(record);
  } catch {
    /* a recorder fault must not fail the operation being audited */
  }
}

/**
 * secure-io publishes its guarded I/O adapters on named channels
 * ('auditChainIo', 'chainIntegrityIo', 'lockIo'). Modules that need a channel
 * register a consumer; whichever side arrives second connects immediately.
 */
export function provideAuditIo(channel: string, io: unknown): void {
  const { auditIoChannels } = registry();
  const state = auditIoChannels.get(channel) ?? { consumers: [] };
  state.io = io;
  auditIoChannels.set(channel, state);
  for (const consumer of state.consumers) {
    try {
      consumer(io);
    } catch {
      /* an io consumer fault must not break secure-io initialization */
    }
  }
}

export function registerAuditIoConsumer(channel: string, consumer: AuditIoConsumer): void {
  const { auditIoChannels } = registry();
  const state = auditIoChannels.get(channel) ?? { consumers: [] };
  state.consumers.push(consumer);
  auditIoChannels.set(channel, state);
  if (state.io !== undefined) {
    try {
      consumer(state.io);
    } catch {
      /* an io consumer fault must not break the consuming module's load */
    }
  }
}
