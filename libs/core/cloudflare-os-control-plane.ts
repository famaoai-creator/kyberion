import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auditChain } from './governance/audit-chain.js';
import {
  assertApprovalUsable,
  computeApprovalPayloadHash,
  decideApprovalRequest,
  isSeparationOfDutiesEnabled,
  loadApprovalRequest,
} from './governance/approval-store.js';
import {
  collectCascadeCancellations,
  assertAdoptable,
  dependencyReadiness,
  drainApprovable,
  persistWithRetry,
  prepareCancellation,
  reconcilePlane,
  requestDeclassify as requestDeclassifyGrant,
} from './cloudflare-os-held-lifecycle.js';
import { resolveProvisionalReferences, summarizeHeldAction } from './cloudflare-os-held-support.js';
import { createHeldApprovalRequest } from './governance/held-effect-request.js';
import {
  assertPersistableParams,
  bindRestoredExecutor,
  lookupHeldExecutor,
  registerHeldExecutor,
} from './cloudflare-os-held-executors.js';
import type {
  HeldActionApprovalLink,
  HeldActionSteeringSpec,
} from './governance/held-effect-bridge.js';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import {
  applyControlPlaneJournalEvent,
  foldPersistedState,
  declassificationKeyOf,
  deserializeGadgetOperation,
  gadgetSchemaToJsonSchema,
  loadPersistedControlPlaneStateAtPath,
  serializableHeldActionRecord,
  serializeGadgetRecord,
  validatePersistedControlPlaneStateAtPath,
  type ControlPlaneJournalCollections,
  type DeclassificationGrant,
  type PersistedControlPlaneState,
} from './cloudflare-os-control-plane-state.js';
import {
  controlPlaneNamespaceFor,
  foldObservationAggregate,
  observationAggregateKey,
  type ControlPlaneCollection,
  type ControlPlaneJournalEvent,
  type ObservationAggregate,
} from './cloudflare-os-journal.js';
import { ControlPlaneJournalStore } from './cloudflare-os-journal-store.js';
import { isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
  safeExecResult,
} from './secure-io.js';
import { evaluateProvenanceEgress, projectProvenanceTaint } from './provenance-taint.js';

/**
 * Kyberion's portable control-plane contracts adopted from the Cloudflare OS
 * review.  This module deliberately contains policy and state transitions,
 * not a new runtime.  Adapters can use it from actuators, surfaces and
 * pipelines while keeping the existing file/mission model as the source of
 * truth.
 */

export type HeldActionStatus =
  'pending' | 'approved' | 'applied' | 'rejected' | 'cancelled' | 'failed';
export type ResourceScope = 'read' | 'write';
export type IntroductionMode = 'warn' | 'enforce';
export type OsKnowledgeTier = 'personal' | 'confidential' | 'public';

/** Validate the execution envelope without pretending to know generic `T`. */
export function normalizeGovernedCodeEnvelope(value: unknown): { value: unknown } | undefined {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'value')) return undefined;
  if (value.value_undefined !== undefined && typeof value.value_undefined !== 'boolean') {
    return undefined;
  }
  return { value: value.value_undefined === true ? undefined : value.value };
}

export interface SimulatedResult {
  provisionalRefs: string[];
  value: unknown;
  simulated: true;
}

export interface HeldActionContext {
  missionId: string;
  taskId?: string;
  tenantSlug?: string;
  submittedBy: string;
  correlationId?: string;
}

export type { HeldActionSteeringSpec, HeldActionApprovalLink };

export interface HeldActionInput<T = unknown, R = unknown> extends HeldActionContext {
  id?: string;
  op: string;
  params: T;
  simulatable?: boolean;
  autoApprovable?: boolean;
  actionTag?: string;
  irreversible?: boolean;
  apply: (params: T, resolvedProvisionalRefs: Map<string, unknown>) => R | Promise<R>;
  simulate?: (params: T) => SimulatedResult;
  revert?: (result: R, previousState: unknown) => void | Promise<void>;
  previousState?: unknown;
  effectBinding?: string;
  payloadHash?: string;
  dependsOn?: string[];
  /**
   * SC-04: when set, submitHeldAction files an approval request steering
   * `kind: 'held_effect'` — the shared store becomes the decision of record.
   */
  steeringApproval?: HeldActionSteeringSpec;
  /** Opt in to persisting `params` (secret-like keys rejected at submit). */
  persistParams?: boolean;
  /** Set by the plane when a steering approval request exists. */
  approvalRequest?: HeldActionApprovalLink;
  /** Exactly-once guard set under the journal lock; never cleared by the plane. */
  applyClaim?: { by: string; at: string };
}

export interface HeldActionRecord<T = unknown, R = unknown> extends HeldActionInput<T, R> {
  id: string;
  status: HeldActionStatus;
  submittedAt: string;
  decidedAt?: string;
  resolvedBy?: string;
  autoApproved: boolean;
  appliedAt?: string;
  result?: R;
  simulation?: SimulatedResult;
  applyError?: string;
  effectBinding: string;
  payloadHash: string;
  dependsOn: string[];
}

/**
 * Safe operator-surface projection of a held action. Executor functions and
 * action payloads never cross this boundary; payloadHash remains available so
 * an authenticated human decision can be bound to the exact queued record.
 */
export interface HeldActionSummary {
  id: string;
  missionId: string;
  taskId?: string;
  tenantSlug?: string;
  submittedBy: string;
  op: string;
  status: HeldActionStatus;
  submittedAt: string;
  decidedAt?: string;
  resolvedBy?: string;
  autoApproved: boolean;
  appliedAt?: string;
  failureRecorded: boolean;
  effectBinding: string;
  payloadHash: string;
  dependsOn: string[];
  actionTag?: string;
  irreversible?: boolean;
  simulatable: boolean;
  provisionalRefs: string[];
  /** SC-04: linked approval-store request when the decision is unified. */
  approvalRequestId?: string;
  /** Set when an apply was claimed; with no outcome it needs an operator (releaseApplyClaim). */
  applyClaim?: { by: string; at: string };
}

export interface HeldActionDecision {
  resolvedBy: string;
  decidedByType: 'human' | 'ai_agent' | 'service';
  authenticated: boolean;
  payloadHash: string;
  effectBinding: string;
  /**
   * SC-04: set when the decision arrives from the held-effect bridge — the
   * linked approval request already settled, so the plane only mirrors it.
   */
  viaApprovalRequest?: boolean;
}

export interface ResourceIntroduction {
  id: string;
  missionId: string;
  taskId?: string;
  service: string;
  resourceRef: string;
  scope: ResourceScope;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ObservationRecord {
  id: string;
  missionId: string;
  taskId?: string;
  service: string;
  resourceRef: string;
  tier: OsKnowledgeTier;
  tenantSlug?: string;
  purpose: string;
  summary: string;
  observedAt: string;
  observedBy?: string;
}

export interface ProvenanceTaint {
  missionId: string;
  highestTier: OsKnowledgeTier;
  tenants: string[];
  prohibitExternal: boolean;
  observationIds: string[];
}

export interface AutoApproveRule {
  op: string;
  actionTag: string;
  enabledBy: string;
  enabledAt: string;
}

export interface CapabilityEdge {
  id: string;
  subject: string;
  resource: string;
  scope: ResourceScope;
  grantedAt: string;
  revokedAt?: string;
  parentId?: string;
  missionId?: string;
  targetAudience?: OsKnowledgeTier | 'external';
  targetTenant?: string;
}

export interface BlueprintBindingRequirement {
  name: string;
  service: string;
  preset?: string;
  secret?: string;
}

export interface BlueprintContract {
  id: string;
  required_bindings: BlueprintBindingRequirement[];
  vocabulary?: Record<string, string>;
  fingerprint?: string;
}

export interface GadgetManifest {
  id: string;
  blueprintId: string;
  bindings: string[];
  capabilitySubject: string;
  tenantSlug: string;
  operations: GadgetOperationDescriptor[];
  sideEffectsHeld: true;
  historyRef: string;
}

export type GadgetOperationEffect = 'read' | 'held';

export interface GadgetOperationDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: GadgetOperationEffect;
  capabilityResource: string;
  introduction: {
    service: string;
    resourceRef: string;
  };
  observation: {
    tier: OsKnowledgeTier;
    purpose: string;
    summary: string;
  };
}

export interface GadgetOperationDefinition<TInput = unknown, TOutput = unknown> extends Omit<
  GadgetOperationDescriptor,
  'inputSchema' | 'outputSchema'
> {
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /** A synchronous expression evaluated inside the governed child process. */
  governedCode: string;
}

export type GadgetOperationInvocation<TOutput = unknown> =
  | { effect: 'read'; value: TOutput }
  | { effect: 'held'; heldActionId: string; heldAction: HeldActionSummary };

export interface GadgetOperationInvocationContext {
  missionId: string;
  submittedBy: string;
  tenantSlug: string;
  taskId?: string;
}

export interface GadgetOperationDiscoveryContext {
  missionId: string;
  principal: string;
  tenantSlug: string;
  taskId?: string;
}

export interface NetworkObservation {
  destination: string;
  allowed: boolean;
  reason?: string;
}

export interface CloudflareOsControlPlaneOptions {
  statePath?: string;
  persist?: boolean;
  /** Read-only adapters must not write a recovery audit while restoring state. */
  auditRestoreFailures?: boolean;
}

function actor(input?: string): string {
  return input?.trim() || getRegisteredEnvText('KYBERION_PERSONA') || 'cloudflare-os-control-plane';
}

function audit(
  action: string,
  operation: string,
  result: 'allowed' | 'denied' | 'completed' | 'failed',
  metadata: Record<string, unknown>
): void {
  auditChain.record({ agentId: actor(), action, operation, result, metadata });
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`[POLICY_VIOLATION] ${label} is required`);
  return normalized;
}

function assertHumanActor(value: string): string {
  const normalized = assertNonEmpty(value, 'human approver');
  if (!normalized.startsWith('human:')) {
    throw new Error('[POLICY_VIOLATION] Persistent auto-approve rules require a human owner');
  }
  return normalized;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isConstantTimeEqual(left: string, right: string): boolean {
  return constantTimeStringEqual(left, right);
}

export class CloudflareOsControlPlane {
  private readonly held = new Map<string, HeldActionRecord>();
  private readonly introductions = new Map<string, ResourceIntroduction>();
  private readonly observations: ObservationRecord[] = [];
  private readonly autoRules: AutoApproveRule[] = [];
  private readonly capabilities = new Map<string, CapabilityEdge>();
  private readonly threadCapabilities = new Map<string, Set<string>>();
  private readonly blueprints = new Map<string, BlueprintContract>();
  private readonly declassifications = new Map<string, DeclassificationGrant>();
  private readonly gadgetOperations = new Map<
    string,
    Map<string, GadgetOperationDefinition<any, any>>
  >();
  private readonly gadgetCapabilitySubjects = new Map<string, string>();
  private readonly gadgetManifests = new Map<string, GadgetManifest>();
  private readonly network: NetworkObservation[] = [];
  private readonly applyInFlight = new Map<string, Promise<HeldActionRecord>>();
  private readonly persist: boolean;
  private readonly statePath: string;
  private readonly auditRestoreFailures: boolean;
  /**
   * SC-03: journal mode is the default persistence — tenant-namespaced
   * append-only journals plus locked tail catch-up. An explicit `statePath`
   * keeps the legacy single-file behavior for tests and pinned adapters.
   */
  private readonly journalMode: boolean;
  private readonly observationAggregates = new Map<string, ObservationAggregate>();
  private readonly instanceId = randomUUID();
  private readonly journalStore = new ControlPlaneJournalStore({
    heldRecord: (id) => this.held.get(id) as unknown as Record<string, unknown> | undefined,
    applyJournalEvent: (event) => this.applyJournalEvent(event),
    serializedJournalRecord: (kind, record) => this.serializedRecordFor(kind, record),
    serializedState: () => this.buildPersistedState(),
    observationAggregatesFor: (namespace) =>
      [...this.observationAggregates.values()].filter(
        (aggregate) =>
          controlPlaneNamespaceFor('observation', aggregate as never).key === namespace.key
      ),
  });

  constructor(options: CloudflareOsControlPlaneOptions = {}) {
    this.persist = options.persist !== false;
    this.auditRestoreFailures = options.auditRestoreFailures !== false;
    this.journalMode = this.persist && !options.statePath;
    this.statePath = this.persist
      ? assertSafeRepositoryPath(
          options.statePath || pathResolver.shared('runtime/cloudflare-os/control-plane.json'),
          { allowMissingLeaf: true }
        )
      : options.statePath || pathResolver.shared('runtime/cloudflare-os/control-plane.json');
    if (this.persist) {
      if (this.journalMode) this.journalStore.restore(this.auditRestoreFailures);
      else this.restoreState();
    }
  }

  registerExecutor<T, R>(
    op: string,
    apply: (params: T, resolvedProvisionalRefs: Map<string, unknown>) => R | Promise<R>,
    revert?: (result: R, previousState: unknown) => void | Promise<void>
  ): void {
    // Bound at apply/revert time (see performApplyHeldAction), never on
    // records — a journal catch-up must not lose it.
    registerHeldExecutor(op, { apply: apply as never, revert: revert as never });
  }

  submitHeldAction<T, R>(input: HeldActionInput<T, R>): HeldActionRecord<T, R> {
    if (input.persistParams) assertPersistableParams(input.params);
    const record = {
      ...input,
      id: input.id || randomUUID(),
      status: 'pending' as const,
      submittedAt: nowIso(),
      autoApproved: false,
      ...(input.simulatable && input.simulate ? { simulation: input.simulate(input.params) } : {}),
      effectBinding: input.effectBinding || input.op,
      payloadHash:
        input.payloadHash ||
        computeApprovalPayloadHash(
          input.params && typeof input.params === 'object'
            ? (input.params as Record<string, unknown>)
            : { value: input.params }
        ),
      dependsOn: [...new Set(input.dependsOn || [])],
    } as HeldActionRecord<T, R>;
    if (input.steeringApproval) {
      record.approvalRequest = createHeldApprovalRequest(record, input.steeringApproval);
    }
    this.held.set(record.id, record as HeldActionRecord);
    this.recordMutation('held', record as HeldActionRecord);
    audit('held_action', 'submit', 'completed', {
      heldActionId: record.id,
      op: record.op,
      missionId: record.missionId,
      taskId: record.taskId,
      simulated: Boolean(record.simulation),
    });
    return record;
  }

  getHeldAction(id: string): HeldActionRecord | undefined {
    return this.held.get(id);
  }

  getHeldActionSummary(id: string): HeldActionSummary | undefined {
    const record = this.held.get(id);
    return record ? summarizeHeldAction(record) : undefined;
  }

  listHeldActionSummaries(missionId?: string): HeldActionSummary[] {
    this.reconcileLinkedApprovals();
    return this.listHeldActions(missionId).map(summarizeHeldAction);
  }

  listHeldActions(missionId?: string): HeldActionRecord[] {
    return [...this.held.values()]
      .filter((entry) => !missionId || entry.missionId === missionId)
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  }

  decideHeldAction(
    id: string,
    decision: 'approved' | 'rejected',
    approval: HeldActionDecision
  ): HeldActionRecord {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    // SC-04: first decision wins — a decided record is audit evidence and
    // must not be silently re-decided (same rule as the approval store).
    if (
      record.status === 'approved' ||
      record.status === 'applied' ||
      record.status === 'rejected' ||
      record.status === 'cancelled'
    )
      return record;
    this.assertHumanDecision(record, approval);
    const by = assertNonEmpty(approval.resolvedBy, 'resolvedBy');
    // SC-04: a linked request settles in the shared store FIRST — one
    // approval path. The held-effect bridge mirrors the decision back via
    // `viaApprovalRequest`; settling locally here too keeps the call
    // synchronous and is idempotent under either ordering.
    if (record.approvalRequest && !approval.viaApprovalRequest) {
      // Held links are minted under mission_controller only — a tampered or
      // migrated record claiming another role fails closed before any write.
      if (record.approvalRequest.role !== 'mission_controller') {
        throw new Error(
          `[POLICY_VIOLATION] Held approval request role '${record.approvalRequest.role}' is not mission_controller`
        );
      }
      decideApprovalRequest('mission_controller', {
        channel: record.approvalRequest.storageChannel,
        storageChannel: record.approvalRequest.storageChannel,
        requestId: record.approvalRequest.requestId,
        decision,
        decidedBy: by,
        decidedByType: approval.decidedByType,
        authenticated: approval.authenticated,
        payloadHash: approval.payloadHash,
        effectBinding: approval.effectBinding,
      });
    }
    record.status = decision === 'approved' ? 'approved' : 'rejected';
    record.resolvedBy = by;
    record.autoApproved = false;
    record.decidedAt = nowIso();
    audit('held_action', 'decide', 'completed', {
      heldActionId: id,
      decision,
      resolvedBy: by,
      autoApproved: false,
    });
    if (decision === 'rejected') this.cancelDependents(record);
    this.recordMutation('held', record);
    return record;
  }

  registerAutoApproveRule(rule: Omit<AutoApproveRule, 'enabledAt'>): AutoApproveRule {
    const normalized = {
      ...rule,
      op: assertNonEmpty(rule.op, 'auto-approve op'),
      actionTag: assertNonEmpty(rule.actionTag, 'auto-approve actionTag'),
      enabledBy: assertHumanActor(rule.enabledBy),
      enabledAt: nowIso(),
    };
    this.autoRules.push(normalized);
    this.recordMutation('auto_rule', normalized);
    return normalized;
  }

  approveEligibleHeldActions(missionId: string): HeldActionRecord[] {
    const eligible = this.listHeldActions(missionId).filter(
      (entry) =>
        entry.status === 'pending' &&
        entry.autoApprovable &&
        this.autoRules.some((rule) => rule.op === entry.op && rule.actionTag === entry.actionTag)
    );
    return eligible.map((entry) => this.decideAutoApproved(entry));
  }

  async drainHeldActions(missionId: string): Promise<HeldActionRecord[]> {
    this.reconcileLinkedApprovals();
    this.approveEligibleHeldActions(missionId);
    return drainApprovable({
      list: () => this.listHeldActions(missionId),
      apply: (id) => this.applyHeldAction(id),
    });
  }

  async applyHeldAction(id: string): Promise<HeldActionRecord> {
    const inFlight = this.applyInFlight.get(id);
    if (inFlight) return inFlight;
    const operation = this.performApplyHeldAction(id);
    this.applyInFlight.set(id, operation);
    try {
      return await operation;
    } finally {
      this.applyInFlight.delete(id);
    }
  }

  private async performApplyHeldAction(id: string): Promise<HeldActionRecord> {
    let record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    if (
      record.status === 'applied' ||
      record.status === 'rejected' ||
      record.status === 'cancelled'
    )
      return record;
    if (record.status !== 'approved')
      throw new Error(`[POLICY_VIOLATION] Held action ${id} is not approved`);
    // Separation of duties: the linked shared-store decision must still be
    // usable (e.g. not a self-approval recorded while the setting was off).
    if (record.approvalRequest && isSeparationOfDutiesEnabled()) {
      const linked = loadApprovalRequest(
        record.approvalRequest.storageChannel,
        record.approvalRequest.requestId
      );
      if (!linked) {
        throw new Error(
          `[POLICY_VIOLATION] Held action ${id} has no linked approval record to verify separation of duties`
        );
      }
      assertApprovalUsable(linked, { consumer: 'held_action_apply' });
    }
    const by = assertNonEmpty(record.resolvedBy || '', 'resolvedBy');
    record.resolvedBy = by;
    // A dependent runs only after its dependencies were applied; one whose
    // dependency can never be applied is cancelled instead of waiting forever.
    const dependencies = dependencyReadiness(record, (depId) => this.held.get(depId));
    if (dependencies === 'dead') return this.settleCancelled(record, 'dependency_not_applied');
    if (dependencies === 'wait') return this.deferApply(record, 'dependency_pending');
    const readiness = bindRestoredExecutor(record);
    if (readiness !== 'ready') return this.deferApply(record, readiness);
    // Exactly-once: claim under the journal lock; a claim is never retried.
    if (this.journalMode) {
      if (!this.journalStore.claimHeldApply(id, `${process.pid}:${this.instanceId}`)) {
        return this.deferApply(record, 'claimed');
      }
      record = this.held.get(id) ?? record;
    }
    try {
      const refs = this.resolvedProvisionalRefs(record.missionId);
      record.result = await record.apply(
        resolveProvisionalReferences(record.params, refs) as never,
        refs
      );
      record.status = 'applied';
      record.appliedAt = nowIso();
      audit('held_action', 'apply', 'completed', {
        heldActionId: id,
        resolvedBy: by,
        autoApproved: record.autoApproved,
      });
    } catch (error) {
      record.status = 'failed';
      record.applyError = error instanceof Error ? error.message : String(error);
      audit('held_action', 'apply', 'failed', { heldActionId: id, error: record.applyError });
      this.cancelDependents(record);
    }
    this.persistOutcome(record);
    return record;
  }

  private persistOutcome(record: HeldActionRecord): void {
    persistWithRetry(
      () => this.recordMutation('held', record),
      () => audit('held_action', 'persist_outcome', 'failed', { heldActionId: record.id })
    );
  }

  /** Bring held actions in line with the approval requests they are linked to. Idempotent. */
  reconcileLinkedApprovals(): number {
    return reconcilePlane({
      listHeldActions: () => this.listHeldActions(),
      decideHeldAction: (id, decision, approval) => this.decideHeldAction(id, decision, approval),
      settleCancelled: (record, reason) => this.settleCancelled(record, reason),
      audit: (operation, metadata) => audit('held_action', operation, 'failed', metadata),
    });
  }

  /**
   * Operator way out for a held action that can no longer proceed (its op was
   * retired, the executor is gone, the request is moot).
   */
  cancelHeldAction(
    id: string,
    approval: HeldActionDecision & { reason: string }
  ): HeldActionRecord {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    this.assertHumanDecision(record, approval);
    const by = assertNonEmpty(approval.resolvedBy, 'resolvedBy');
    const reason = assertNonEmpty(approval.reason, 'reason');
    prepareCancellation(record, by, reason);
    return this.settleCancelled(record, reason, by);
  }

  /** Re-home a tenantless (quarantined) held action into its tenant. Authenticated human + reason. */
  adoptQuarantinedHeldAction(
    id: string,
    tenantSlug: string,
    approval: HeldActionDecision & { reason: string }
  ): HeldActionRecord {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    this.assertHumanDecision(record, approval);
    const by = assertNonEmpty(approval.resolvedBy, 'resolvedBy');
    const reason = assertNonEmpty(approval.reason, 'reason');
    if (!this.journalMode)
      throw new Error('[POLICY_VIOLATION] Quarantine exists only in journal mode');
    assertAdoptable(record, tenantSlug);
    record.tenantSlug = tenantSlug;
    this.recordMutation('held', record); // routes into the tenant's journal
    this.journalStore.tombstoneUnscoped('held', id);
    audit('held_action', 'adopt_quarantined', 'completed', {
      heldActionId: id,
      tenantSlug,
      by,
      reason,
    });
    return record;
  }

  /**
   * Operator escape hatch for a claim whose outcome was never recorded (the
   * claiming process died). Only an authenticated human bound to this exact
   * payload can release it, with a reason; the plane never releases on its
   * own because the effect may already have run.
   */
  releaseApplyClaim(
    id: string,
    approval: HeldActionDecision & { reason: string }
  ): HeldActionRecord {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    this.assertHumanDecision(record, approval);
    const by = assertNonEmpty(approval.resolvedBy, 'resolvedBy');
    const reason = assertNonEmpty(approval.reason, 'reason');
    const claim = record.applyClaim;
    if (!this.journalMode || !this.journalStore.releaseHeldApplyClaim(id)) {
      throw new Error(`[POLICY_VIOLATION] Held action ${id} has no releasable apply claim`);
    }
    audit('held_action', 'release_claim', 'completed', { heldActionId: id, by, reason, claim });
    return this.held.get(id) ?? record;
  }

  /** Not-run outcome: nothing is written, so a process that can run it still can. */
  private deferApply(record: HeldActionRecord, reason: string): HeldActionRecord {
    audit('held_action', 'apply', 'denied', { heldActionId: record.id, deferred: true, reason });
    return this.held.get(record.id) ?? record;
  }

  async revertHeldAction(id: string): Promise<HeldActionRecord> {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    const revert =
      record.revert ?? (lookupHeldExecutor(record.op)?.revert as HeldActionRecord['revert']);
    if (record.status !== 'applied' || !revert)
      throw new Error(`[POLICY_VIOLATION] Held action ${id} is not revertible`);
    await revert(record.result, record.previousState);
    record.status = 'cancelled';
    audit('held_action', 'revert', 'completed', { heldActionId: id });
    this.recordMutation('held', record);
    return record;
  }

  assertMissionFinishable(missionId: string): void {
    const unresolved = this.listHeldActions(missionId).filter(
      (entry) => entry.simulation?.provisionalRefs.length && entry.status !== 'applied'
    );
    if (unresolved.length > 0)
      throw new Error(
        `[POLICY_VIOLATION] Mission has unresolved provisional actions: ${unresolved.map((entry) => entry.id).join(', ')}`
      );
  }

  private grantIntroduction(
    input: Omit<ResourceIntroduction, 'id' | 'grantedAt' | 'revokedAt'>
  ): ResourceIntroduction {
    const introduction = { ...input, id: randomUUID(), grantedAt: nowIso() };
    this.introductions.set(introduction.id, introduction);
    audit('resource_introduction', 'grant', 'completed', introduction);
    this.recordMutation('introduction', introduction);
    return introduction;
  }

  requestResourceIntroduction(
    input: Omit<ResourceIntroduction, 'id' | 'grantedAt' | 'grantedBy' | 'revokedAt'> & {
      requestedBy: string;
    }
  ): HeldActionRecord {
    let record!: HeldActionRecord;
    record = this.submitHeldAction({
      missionId: input.missionId,
      taskId: input.taskId,
      submittedBy: input.requestedBy,
      op: 'resource:introduction',
      params: input,
      simulatable: false,
      apply: () =>
        this.grantIntroduction({
          ...input,
          grantedBy: assertHumanActor(record.resolvedBy || ''),
        }),
    });
    return record;
  }

  /** SC-06: hash-bound declassify grant (see cloudflare-os-held-lifecycle.ts). */
  requestDeclassify(
    input: Omit<DeclassificationGrant, 'id' | 'grantedAt' | 'grantedBy'> & {
      requestedBy: string;
    }
  ): HeldActionRecord {
    return requestDeclassifyGrant(
      {
        submit: (held) => this.submitHeldAction(held as unknown as HeldActionInput),
        grants: this.declassifications,
        audit: (operation, metadata) => audit('declassification', operation, 'completed', metadata),
        persist: (grant) =>
          this.recordMutation('declassification', grant as unknown as Record<string, unknown>),
        assertHuman: assertHumanActor,
      },
      input
    );
  }

  /**
   * SC-06: does an applied declassify grant cover this exact artifact +
   * destination? Hash-bound — any content change re-denies.
   */
  isDeclassified(
    missionId: string,
    payloadHash: string,
    targetAudience: string,
    targetTenant?: string
  ): boolean {
    return this.declassifications.has(
      declassificationKeyOf({ missionId, payloadHash, targetAudience, targetTenant })
    );
  }

  revokeIntroduction(id: string, revokedBy: string): void {
    const entry = this.introductions.get(id);
    if (!entry) throw new Error(`Resource introduction not found: ${id}`);
    if (!entry.revokedAt) entry.revokedAt = nowIso();
    audit('resource_introduction', 'revoke', 'completed', { id, revokedBy });
    this.recordMutation('introduction', entry);
  }

  enforceIntroduction(input: {
    missionId: string;
    taskId?: string;
    service: string;
    resourceRef: string;
    scope: ResourceScope;
    mode?: IntroductionMode;
  }): boolean {
    const active = [...this.introductions.values()].some(
      (entry) =>
        entry.missionId === input.missionId &&
        entry.taskId === input.taskId &&
        entry.service === input.service &&
        entry.resourceRef === input.resourceRef &&
        (entry.scope === 'write' || entry.scope === input.scope) &&
        !entry.revokedAt &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now())
    );
    if (!active && (input.mode || 'enforce') === 'enforce') {
      audit('resource_introduction', 'enforce', 'denied', input);
      throw new Error(
        `[POLICY_VIOLATION] Resource introduction required for ${input.service}:${input.resourceRef}`
      );
    }
    audit('resource_introduction', 'enforce', active ? 'allowed' : 'completed', {
      ...input,
      mode: input.mode || 'enforce',
    });
    return active;
  }

  recordObservation(input: Omit<ObservationRecord, 'id' | 'observedAt'>): ObservationRecord {
    const record = { ...input, id: randomUUID(), observedAt: nowIso() };
    this.observations.push(record);
    // Audit the first sight of a resource; repeats are in the journal and the rollup count.
    const firstSight = !this.observationAggregates.has(observationAggregateKey(record));
    foldObservationAggregate(this.observationAggregates, record);
    if (firstSight) audit('observation', 'read', 'completed', record);
    this.recordMutation('observation', record);
    return record;
  }

  listObservations(missionId?: string): ObservationRecord[] {
    this.refreshPersistedObservations();
    return this.observations.filter((entry) => !missionId || entry.missionId === missionId);
  }

  projectTaint(missionId: string): ProvenanceTaint {
    this.refreshPersistedObservations();
    return projectProvenanceTaint(missionId, this.observations);
  }

  assertEgressAllowed(
    missionId: string,
    targetAudience: OsKnowledgeTier | 'external',
    targetTenant?: string
  ): void {
    const taint = this.projectTaint(missionId);
    const verdict = evaluateProvenanceEgress(taint, targetAudience, targetTenant);
    if (!verdict.allowed) {
      audit('provenance', 'egress', 'denied', {
        missionId,
        targetAudience,
        targetTenant,
        taint,
        reason: verdict.reason,
      });
      throw new Error(
        `[POLICY_VIOLATION] Egress denied by provenance taint for mission ${missionId}`
      );
    }
  }

  runGovernedCode<T>(code: string, bindings: Record<string, unknown>, timeoutMs = 1000): T {
    if (code.length > 80_000)
      throw new Error('[POLICY_VIOLATION] Governed Code Mode input is too large');
    const script = [
      "'use strict';",
      'process.env = Object.create(null);',
      "for (const key of ['fetch', 'WebSocket', 'XMLHttpRequest']) Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });",
      `const bindings = Object.freeze(${JSON.stringify(bindings)});`,
      `const value = (${code});`,
      "if (value && typeof value.then === 'function') throw new Error('async governed code is not supported');",
      'process.stdout.write(JSON.stringify(value === undefined ? { value: null, value_undefined: true } : { value }));',
    ].join('\n');
    const result = safeExecResult(
      process.execPath,
      ['--permission', '--input-type=module', '--eval', script],
      { timeoutMs, env: {} }
    );
    if (result.status !== 0) {
      throw new Error(
        `[POLICY_VIOLATION] Governed Code Mode failed: ${result.stderr.slice(0, 500)}`
      );
    }
    try {
      const envelope = normalizeGovernedCodeEnvelope(
        parseSafeJsonInput(result.stdout, 'governed code response')
      );
      if (!envelope) throw new Error('missing value envelope');
      return envelope.value as T;
    } catch (error) {
      throw new Error(
        `[POLICY_VIOLATION] Governed Code Mode returned invalid data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  buildKnowledgeCatalog(
    entries: Array<{ id: string; title: string; description: string }>,
    maxEntries = 32,
    maxFieldLength = 240
  ): Array<{ id: string; title: string; description: string }> {
    return entries.slice(0, maxEntries).map((entry) => ({
      id: entry.id.slice(0, maxFieldLength),
      title: entry.title.slice(0, maxFieldLength),
      description: `[UNTRUSTED CATALOG DATA] ${entry.description.slice(0, maxFieldLength)}`,
    }));
  }

  bindThreadCapability(threadId: string, capabilityId: string): void {
    const set = this.threadCapabilities.get(threadId) || new Set<string>();
    set.add(capabilityId);
    this.threadCapabilities.set(threadId, set);
    this.recordMutation('thread_capability', { threadId, capabilities: [...set] });
  }

  assertThreadCapability(threadId: string, capabilityId: string): void {
    if (!this.threadCapabilities.get(threadId)?.has(capabilityId))
      throw new Error(
        `[POLICY_VIOLATION] Capability ${capabilityId} is not bound to thread ${threadId}`
      );
  }

  registerBlueprint(blueprint: BlueprintContract): BlueprintContract {
    if (!blueprint.id || !Array.isArray(blueprint.required_bindings))
      throw new Error('[POLICY_VIOLATION] Blueprint binding declaration is required');
    this.blueprints.set(blueprint.id, blueprint);
    this.recordMutation('blueprint', blueprint);
    return blueprint;
  }

  instantiateBlueprint(blueprintId: string, bindings: Record<string, unknown>): string[] {
    const blueprint = this.blueprints.get(blueprintId);
    if (!blueprint) throw new Error(`Blueprint not found: ${blueprintId}`);
    const missing = blueprint.required_bindings.filter(
      (requirement) => !(requirement.name in bindings)
    );
    if (missing.length > 0)
      throw new Error(
        `[POLICY_VIOLATION] Missing blueprint bindings: ${missing.map((entry) => entry.name).join(', ')}`
      );
    return blueprint.required_bindings.map((entry) => entry.name);
  }

  grantCapability(
    subject: string,
    resource: string,
    scope: ResourceScope,
    options: {
      parentId?: string;
      missionId?: string;
      targetAudience?: OsKnowledgeTier | 'external';
      targetTenant?: string;
    } = {}
  ): CapabilityEdge {
    if (options.parentId) {
      const parent = this.capabilities.get(options.parentId);
      if (!parent || parent.revokedAt)
        throw new Error('[POLICY_VIOLATION] Capability parent is not active');
    }
    if (options.missionId && options.targetAudience) {
      this.assertEgressAllowed(options.missionId, options.targetAudience, options.targetTenant);
    }
    const edge = {
      id: randomUUID(),
      subject,
      resource,
      scope,
      grantedAt: nowIso(),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.missionId ? { missionId: options.missionId } : {}),
      ...(options.targetAudience ? { targetAudience: options.targetAudience } : {}),
      ...(options.targetTenant ? { targetTenant: options.targetTenant } : {}),
    };
    this.capabilities.set(edge.id, edge);
    audit('capability', 'grant', 'completed', edge);
    this.recordMutation('capability', edge);
    return edge;
  }

  revokeCapability(id: string, revokedBy: string): void {
    const edge = this.capabilities.get(id);
    if (!edge) throw new Error(`Capability edge not found: ${id}`);
    edge.revokedAt ||= nowIso();
    audit('capability', 'revoke', 'completed', { id, revokedBy });
    this.recordMutation('capability', edge);
  }

  assertCapability(subject: string, resource: string, scope: ResourceScope): void {
    const allowed = [...this.capabilities.values()].some((edge) => {
      if (
        edge.subject !== subject ||
        edge.resource !== resource ||
        !this.isCapabilityActive(edge) ||
        (edge.scope !== 'write' && edge.scope !== scope)
      )
        return false;
      if (edge.missionId && edge.targetAudience) {
        try {
          this.assertEgressAllowed(edge.missionId, edge.targetAudience, edge.targetTenant);
        } catch {
          return false;
        }
      }
      return true;
    });
    if (!allowed)
      throw new Error(`[POLICY_VIOLATION] Capability denied: ${subject} -> ${scope} ${resource}`);
  }

  generateGadget(input: {
    id: string;
    blueprintId: string;
    bindings: Record<string, unknown>;
    capabilitySubject: string;
    tenantSlug: string;
    operations: GadgetOperationDefinition[];
  }): GadgetManifest {
    if (this.gadgetManifests.has(input.id))
      throw new Error(`[POLICY_VIOLATION] Gadget already exists: ${input.id}`);
    const capabilitySubject = assertNonEmpty(input.capabilitySubject, 'gadget capability subject');
    const tenantSlug = assertNonEmpty(input.tenantSlug, 'gadget tenantSlug');
    if (input.operations.length === 0)
      throw new Error('[POLICY_VIOLATION] Gadget operation contract is required');
    const bindingNames = this.instantiateBlueprint(input.blueprintId, input.bindings);
    const operationNames = new Set<string>();
    const normalizedOperations = input.operations.map((operation) => {
      const name = assertNonEmpty(operation.name, 'gadget operation name');
      if (operationNames.has(name))
        throw new Error(`[POLICY_VIOLATION] Duplicate gadget operation: ${name}`);
      operationNames.add(name);
      assertNonEmpty(operation.description, `gadget operation description (${name})`);
      assertNonEmpty(operation.capabilityResource, `gadget operation capability (${name})`);
      assertNonEmpty(operation.governedCode, `gadget operation governedCode (${name})`);
      if (operation.effect !== 'read' && operation.effect !== 'held')
        throw new Error(`[POLICY_VIOLATION] Invalid gadget operation effect: ${name}`);
      assertNonEmpty(
        operation.introduction.service,
        `gadget operation introduction service (${name})`
      );
      assertNonEmpty(
        operation.introduction.resourceRef,
        `gadget operation introduction resourceRef (${name})`
      );
      assertNonEmpty(
        operation.observation.purpose,
        `gadget operation observation purpose (${name})`
      );
      assertNonEmpty(
        operation.observation.summary,
        `gadget operation observation summary (${name})`
      );
      return { ...operation, name };
    });
    const operations = normalizedOperations.map((operation) => {
      const name = operation.name;
      return {
        name,
        description: operation.description,
        inputSchema: gadgetSchemaToJsonSchema(operation.inputSchema),
        outputSchema: gadgetSchemaToJsonSchema(operation.outputSchema),
        effect: operation.effect,
        capabilityResource: operation.capabilityResource,
        introduction: operation.introduction,
        observation: operation.observation,
      } satisfies GadgetOperationDescriptor;
    });
    this.gadgetOperations.set(
      input.id,
      new Map(normalizedOperations.map((operation) => [operation.name, operation]))
    );
    this.gadgetCapabilitySubjects.set(input.id, capabilitySubject);
    const manifest: GadgetManifest = {
      id: input.id,
      blueprintId: input.blueprintId,
      bindings: bindingNames,
      capabilitySubject,
      tenantSlug,
      operations,
      sideEffectsHeld: true,
      historyRef: `mission-git:${input.id}`,
    };
    this.gadgetManifests.set(input.id, manifest);
    this.recordMutation(
      'gadget',
      serializeGadgetRecord(
        this.gadgetManifests.get(input.id) as GadgetManifest,
        this.gadgetOperations.get(input.id)
      )
    );
    return manifest;
  }

  discoverGadgetOperations(
    gadgetId: string,
    context: GadgetOperationDiscoveryContext
  ): GadgetOperationDescriptor[] {
    const manifest = this.gadgetManifests.get(gadgetId);
    if (!manifest) throw new Error(`Gadget not found: ${gadgetId}`);
    const operations = this.gadgetOperations.get(gadgetId);
    if (!operations)
      throw new Error(`[POLICY_VIOLATION] Gadget runtime is not registered: ${gadgetId}`);
    const missionId = assertNonEmpty(context.missionId, 'gadget discovery missionId');
    const principal = assertNonEmpty(context.principal, 'gadget discovery principal');
    const tenantSlug = assertNonEmpty(context.tenantSlug, 'gadget discovery tenantSlug');
    if (tenantSlug !== manifest.tenantSlug)
      throw new Error(
        `[POLICY_VIOLATION] Gadget tenant scope mismatch: expected ${manifest.tenantSlug}`
      );
    audit('gadget', 'discover', 'completed', { gadgetId, missionId, principal, tenantSlug });
    return [...operations.values()]
      .filter((operation) => {
        try {
          const scope: ResourceScope = operation.effect === 'held' ? 'write' : 'read';
          this.enforceIntroduction({
            missionId,
            taskId: context.taskId,
            service: operation.introduction.service,
            resourceRef: operation.introduction.resourceRef,
            scope,
          });
          this.assertCapability(manifest.capabilitySubject, operation.capabilityResource, scope);
          return true;
        } catch {
          return false;
        }
      })
      .map((operation) => ({
        name: operation.name,
        description: operation.description,
        inputSchema: gadgetSchemaToJsonSchema(operation.inputSchema),
        outputSchema: gadgetSchemaToJsonSchema(operation.outputSchema),
        effect: operation.effect,
        capabilityResource: operation.capabilityResource,
        introduction: operation.introduction,
        observation: operation.observation,
      }));
  }

  async invokeGadgetOperation<TOutput = unknown>(
    gadgetId: string,
    operationName: string,
    input: unknown,
    context: GadgetOperationInvocationContext
  ): Promise<GadgetOperationInvocation<TOutput>> {
    const manifest = this.gadgetManifests.get(gadgetId);
    if (!manifest) throw new Error(`Gadget not found: ${gadgetId}`);
    const operations = this.gadgetOperations.get(gadgetId);
    if (!operations)
      throw new Error(`[POLICY_VIOLATION] Gadget runtime is not registered: ${gadgetId}`);
    const operation = operations.get(operationName);
    if (!operation) throw new Error(`Gadget operation not found: ${gadgetId}/${operationName}`);
    const parsed = operation.inputSchema.safeParse(input);
    if (!parsed.success)
      throw new Error(
        `[POLICY_VIOLATION] Invalid input for gadget operation ${gadgetId}/${operationName}: ${parsed.error.message}`
      );

    const missionId = assertNonEmpty(context.missionId, 'gadget missionId');
    const submittedBy = assertNonEmpty(context.submittedBy, 'gadget submittedBy');
    const tenantSlug = assertNonEmpty(context.tenantSlug, 'gadget tenantSlug');
    if (tenantSlug !== manifest.tenantSlug)
      throw new Error(
        `[POLICY_VIOLATION] Gadget tenant scope mismatch: expected ${manifest.tenantSlug}`
      );
    const capability = this.gadgetCapabilitySubject(gadgetId);
    const scope: ResourceScope = operation.effect === 'held' ? 'write' : 'read';
    this.enforceIntroduction({
      missionId,
      taskId: context.taskId,
      service: operation.introduction.service,
      resourceRef: operation.introduction.resourceRef,
      scope,
    });
    this.assertCapability(capability, operation.capabilityResource, scope);
    if (operation.effect === 'read') {
      const value = operation.outputSchema.parse(
        this.runGovernedCode<unknown>(operation.governedCode, { input: parsed.data })
      );
      this.recordObservation({
        missionId,
        taskId: context.taskId,
        service: operation.introduction.service,
        resourceRef: operation.introduction.resourceRef,
        tier: operation.observation.tier,
        tenantSlug,
        purpose: operation.observation.purpose,
        summary: operation.observation.summary,
        observedBy: submittedBy,
      });
      return { effect: 'read', value: value as TOutput };
    }

    const record = this.submitHeldAction({
      missionId,
      taskId: context.taskId,
      tenantSlug,
      submittedBy,
      op: `gadget:${gadgetId}:${operationName}`,
      params: parsed.data,
      effectBinding: `${capability}:${operationName}`,
      apply: (params) => {
        this.assertCapability(capability, operation.capabilityResource, 'write');
        return operation.outputSchema.parse(
          this.runGovernedCode<unknown>(operation.governedCode, { input: params })
        );
      },
    });
    return { effect: 'held', heldActionId: record.id, heldAction: summarizeHeldAction(record) };
  }

  private gadgetCapabilitySubject(gadgetId: string): string {
    const subject = this.gadgetCapabilitySubjects.get(gadgetId);
    if (!subject) throw new Error(`Gadget not found: ${gadgetId}`);
    return subject;
  }

  recordNetworkAttempt(entry: NetworkObservation): void {
    this.network.push(entry);
    this.recordMutation('network', entry);
    audit(
      'network',
      entry.allowed ? 'egress_allowed' : 'egress_denied',
      entry.allowed ? 'allowed' : 'denied',
      entry as unknown as Record<string, unknown>
    );
  }

  assertNoUnexpectedNetworkEgress(): void {
    const unexpected = this.network.filter((entry) => entry.allowed);
    if (unexpected.length > 0)
      throw new Error(
        `[POLICY_VIOLATION] Unexpected network egress: ${unexpected.map((entry) => entry.destination).join(', ')}`
      );
  }

  async withNetworkEgressGuard<T>(
    run: () => T | Promise<T>,
    allowedHosts: string[] = []
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      );
      const allowed = allowedHosts.includes(url.hostname);
      this.recordNetworkAttempt({
        destination: url.href,
        allowed,
        reason: allowed ? 'interceptor allowlist' : 'interceptor deny',
      });
      if (!allowed) throw new Error(`[POLICY_VIOLATION] Network egress denied: ${url.hostname}`);
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  private resolvedProvisionalRefs(missionId: string): Map<string, unknown> {
    const resolved = new Map<string, unknown>();
    for (const entry of this.listHeldActions(missionId))
      for (const ref of entry.simulation?.provisionalRefs || [])
        if (entry.status === 'applied') resolved.set(ref, entry.result);
    return resolved;
  }

  private isCapabilityActive(edge: CapabilityEdge, seen = new Set<string>()): boolean {
    if (edge.revokedAt || seen.has(edge.id)) return false;
    if (!edge.parentId) return true;
    seen.add(edge.id);
    const parent = this.capabilities.get(edge.parentId);
    return Boolean(parent && this.isCapabilityActive(parent, seen));
  }

  private cancelDependents(root: HeldActionRecord): void {
    const dependents = collectCascadeCancellations(root, this.listHeldActions(root.missionId));
    for (const entry of dependents) {
      entry.status = 'cancelled';
      audit('held_action', 'cascade_cancel', 'completed', {
        heldActionId: entry.id,
        dependsOn: root.id,
      });
    }
    this.recordMutation('held', ...dependents);
  }

  /** End a held action that can no longer proceed, taking its dependents with it. */
  private settleCancelled(record: HeldActionRecord, reason: string, by?: string): HeldActionRecord {
    record.status = 'cancelled';
    record.decidedAt = nowIso();
    audit('held_action', 'cancel', 'completed', { heldActionId: record.id, reason, by });
    this.cancelDependents(record);
    this.recordMutation('held', record);
    return record;
  }

  private decideAutoApproved(record: HeldActionRecord): HeldActionRecord {
    const rule = this.autoRules.find(
      (candidate) => candidate.op === record.op && candidate.actionTag === record.actionTag
    );
    if (!rule || !record.autoApprovable) {
      throw new Error(`[POLICY_VIOLATION] Auto-approve double gate failed for ${record.id}`);
    }
    record.status = 'approved';
    record.resolvedBy = `auto-approve:${rule.enabledBy}`;
    record.autoApproved = true;
    record.decidedAt = nowIso();
    audit('held_action', 'decide', 'completed', {
      heldActionId: record.id,
      decision: 'approved',
      resolvedBy: record.resolvedBy,
      autoApproved: true,
    });
    this.recordMutation('held', record);
    return record;
  }

  private assertHumanDecision(record: HeldActionRecord, approval: HeldActionDecision): void {
    if (approval.decidedByType !== 'human' || approval.authenticated !== true) {
      throw new Error('[POLICY_VIOLATION] Held action decisions require an authenticated human');
    }
    if (approval.payloadHash !== record.payloadHash) {
      throw new Error('[POLICY_VIOLATION] Held action payload hash does not match');
    }
    if (approval.effectBinding !== record.effectBinding) {
      throw new Error('[POLICY_VIOLATION] Held action effect binding does not match');
    }
  }

  /**
   * SC-03: route a mutation to the tenant-namespaced journal. In legacy file
   * mode (explicit statePath) it degrades to the single-file persist so
   * existing adapters keep working unchanged.
   */
  private recordMutation(kind: ControlPlaneCollection, ...records: unknown[]): void {
    if (records.length === 0 || !this.persist) return;
    if (!this.journalMode) {
      this.persistState();
      return;
    }
    this.journalStore.recordMutation(kind, records);
  }

  /** Strip executable state the journal must never carry. */
  private serializedRecordFor(
    kind: ControlPlaneCollection,
    record: unknown
  ): Record<string, unknown> {
    if (kind === 'held') {
      return serializableHeldActionRecord(record as Record<string, unknown>);
    }
    return record as Record<string, unknown>;
  }

  private deserializeGadgetOperation(operation: Record<string, unknown>) {
    return deserializeGadgetOperation(operation);
  }

  private journalCollections(): ControlPlaneJournalCollections {
    return {
      held: this.held,
      introductions: this.introductions,
      observations: this.observations,
      autoRules: this.autoRules,
      capabilities: this.capabilities,
      threadCapabilities: this.threadCapabilities,
      blueprints: this.blueprints,
      declassifications: this.declassifications,
      network: this.network,
      observationAggregates: this.observationAggregates,
      gadgets: {
        manifests: this.gadgetManifests,
        capabilitySubjects: this.gadgetCapabilitySubjects,
        operations: this.gadgetOperations,
        deserializeOperation: (operation) => deserializeGadgetOperation(operation),
      },
    };
  }

  /** Fold one journal event into the in-memory projection. */
  private applyJournalEvent(event: ControlPlaneJournalEvent): void {
    applyControlPlaneJournalEvent(this.journalCollections(), event);
  }

  /**
   * SC-05: catch the in-memory projection up to persisted state — journal
   * tail in journal mode, observation splice in legacy file mode.
   */
  refreshFromJournals(): void {
    if (this.journalMode) this.journalStore.refresh();
    else this.refreshPersistedObservations();
    this.reconcileLinkedApprovals();
  }

  /** SC-03: observation rollups by mission × resource_ref × tier. */
  listObservationAggregates(missionId?: string): ObservationAggregate[] {
    return [...this.observationAggregates.values()].filter(
      (aggregate) => !missionId || aggregate.missionId === missionId
    );
  }

  /**
   * The fully serialized projection — shared by the legacy single-file
   * persist and the per-namespace snapshot cache the journal store writes.
   */
  private buildPersistedState(): PersistedControlPlaneState {
    return {
      version: 1,
      // Executor closures and params are stripped unless the submitter
      // opted in to persistParams (SC-04).
      held: [...this.held.values()].map(
        (record) =>
          serializableHeldActionRecord(record as unknown as Record<string, unknown>) as never
      ),
      introductions: [...this.introductions.values()],
      observations: [...this.observations],
      autoRules: [...this.autoRules],
      capabilities: [...this.capabilities.values()],
      threadCapabilities: Object.fromEntries(
        [...this.threadCapabilities.entries()].map(([threadId, capabilities]) => [
          threadId,
          [...capabilities],
        ])
      ),
      blueprints: [...this.blueprints.values()],
      declassifications: [...this.declassifications.values()],
      network: [...this.network],
      gadgets: [...this.gadgetManifests.values()].flatMap((manifest) => {
        const operations = this.gadgetOperations.get(manifest.id);
        if (!operations) return [];
        return [serializeGadgetRecord(manifest, operations)];
      }),
    };
  }

  private persistState(): void {
    if (!this.persist) return;
    const directory = pathResolver.shared('runtime/cloudflare-os');
    safeMkdir(directory, { recursive: true });
    const state = this.buildPersistedState();
    validatePersistedControlPlaneStateAtPath(this.statePath, state);
    safeWriteFile(this.statePath, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
  }

  private restoreState(): void {
    if (!safeExistsSync(this.statePath)) return;
    try {
      const state = loadPersistedControlPlaneStateAtPath(this.statePath);
      if (state) foldPersistedState(this.journalCollections(), state);
    } catch (error) {
      if (this.auditRestoreFailures) {
        audit('control_plane', 'restore', 'failed', {
          statePath: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private refreshPersistedObservations(): void {
    if (!this.persist) return;
    if (this.journalMode) {
      // SC-03: catch up every journal so provenance reads see cross-process writes.
      this.journalStore.refresh();
      return;
    }
    if (!safeExistsSync(this.statePath)) return;
    try {
      const state = loadPersistedControlPlaneStateAtPath(this.statePath);
      if (!state) return;
      this.observations.splice(0, this.observations.length, ...state.observations);
    } catch (error) {
      if (this.auditRestoreFailures) {
        audit('control_plane', 'observation_refresh', 'failed', {
          statePath: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export function assertImmutableAuthConfig(
  config: Record<string, unknown>,
  baseline: Record<string, unknown>,
  immutableKeys: string[]
): void {
  const changed = immutableKeys.filter(
    (key) => JSON.stringify(config[key]) !== JSON.stringify(baseline[key])
  );
  if (changed.length > 0)
    throw new Error(
      `[POLICY_VIOLATION] Authentication configuration is immutable at runtime: ${changed.join(', ')}`
    );
}

export const AUTH_CONFIG_BOUNDARY_INVENTORY = [
  { setting: 'viewer_scope_mode', allowedSources: ['environment'] },
  { setting: 'tenant_registry', allowedSources: ['human-approved-file'] },
  { setting: 'service_credentials', allowedSources: ['environment', 'human-approved-file'] },
  { setting: 'oauth_profile', allowedSources: ['human-approved-file'] },
  { setting: 'oauth_callback_surface', allowedSources: ['environment', 'interactive-human'] },
] as const;

type AuthConfigSetting = (typeof AUTH_CONFIG_BOUNDARY_INVENTORY)[number]['setting'];
type AuthConfigSource =
  | 'environment'
  | 'human-approved-file'
  | 'interactive-human'
  | 'http-request'
  | 'surface-state'
  | 'gadget-operation';

export function assertAuthConfigMutationSource(
  setting: AuthConfigSetting,
  source: AuthConfigSource,
  humanApprover?: string
): void {
  const entry = AUTH_CONFIG_BOUNDARY_INVENTORY.find((candidate) => candidate.setting === setting);
  if (!entry || !(entry.allowedSources as readonly string[]).includes(source)) {
    throw new Error(
      `[POLICY_VIOLATION] Authentication configuration cannot be changed from ${source}: ${setting}`
    );
  }
  if (
    (source === 'human-approved-file' || source === 'interactive-human') &&
    !humanApprover?.startsWith('human:')
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Authentication configuration file changes require a human approver: ${setting}`
    );
  }
}
