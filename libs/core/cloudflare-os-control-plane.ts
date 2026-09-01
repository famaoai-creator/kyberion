import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fromJSONSchema, z } from 'zod';
import { auditChain } from './audit-chain.js';
import { computeApprovalPayloadHash } from './approval-store.js';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { readJson } from './foundation/json.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
  safeExecResult,
} from './secure-io.js';
import { projectProvenanceTaint } from './provenance-taint.js';

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
}

export interface HeldActionDecision {
  resolvedBy: string;
  decidedByType: 'human' | 'ai_agent' | 'service';
  authenticated: boolean;
  payloadHash: string;
  effectBinding: string;
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

interface PersistedControlPlaneState {
  version: 1;
  held: Array<Record<string, unknown>>;
  introductions: ResourceIntroduction[];
  observations: ObservationRecord[];
  autoRules: AutoApproveRule[];
  capabilities: CapabilityEdge[];
  threadCapabilities: Record<string, string[]>;
  blueprints: BlueprintContract[];
  network: NetworkObservation[];
  gadgets: PersistedGadget[];
}

interface PersistedGadget {
  manifest: GadgetManifest;
  operations: Array<GadgetOperationDescriptor & { governedCode: string }>;
}

const TIER_RANK: Record<OsKnowledgeTier, number> = { public: 0, confidential: 1, personal: 2 };

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

function schemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
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

  constructor(options: CloudflareOsControlPlaneOptions = {}) {
    this.persist = options.persist !== false;
    this.auditRestoreFailures = options.auditRestoreFailures !== false;
    this.statePath = this.persist
      ? assertSafeRepositoryPath(
          options.statePath || pathResolver.shared('runtime/cloudflare-os/control-plane.json'),
          { allowMissingLeaf: true }
        )
      : options.statePath || pathResolver.shared('runtime/cloudflare-os/control-plane.json');
    if (this.persist) this.restoreState();
  }

  registerExecutor<T, R>(
    op: string,
    apply: (params: T, resolvedProvisionalRefs: Map<string, unknown>) => R | Promise<R>,
    revert?: (result: R, previousState: unknown) => void | Promise<void>
  ): void {
    for (const record of this.held.values()) {
      if (record.op !== op) continue;
      record.apply = apply as HeldActionRecord['apply'];
      record.revert = revert as HeldActionRecord['revert'];
    }
  }

  submitHeldAction<T, R>(input: HeldActionInput<T, R>): HeldActionRecord<T, R> {
    const record = {
      ...input,
      id: input.id || randomUUID(),
      status: 'pending' as const,
      submittedAt: new Date().toISOString(),
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
    this.held.set(record.id, record as HeldActionRecord);
    this.persistState();
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
    if (
      record.status === 'applied' ||
      record.status === 'rejected' ||
      record.status === 'cancelled'
    )
      return record;
    this.assertHumanDecision(record, approval);
    const by = assertNonEmpty(approval.resolvedBy, 'resolvedBy');
    record.status = decision === 'approved' ? 'approved' : 'rejected';
    record.resolvedBy = by;
    record.autoApproved = false;
    record.decidedAt = new Date().toISOString();
    audit('held_action', 'decide', 'completed', {
      heldActionId: id,
      decision,
      resolvedBy: by,
      autoApproved: false,
    });
    if (decision === 'rejected') this.cancelDependents(record);
    this.persistState();
    return record;
  }

  registerAutoApproveRule(rule: Omit<AutoApproveRule, 'enabledAt'>): AutoApproveRule {
    const normalized = {
      ...rule,
      op: assertNonEmpty(rule.op, 'auto-approve op'),
      actionTag: assertNonEmpty(rule.actionTag, 'auto-approve actionTag'),
      enabledBy: assertHumanActor(rule.enabledBy),
      enabledAt: new Date().toISOString(),
    };
    this.autoRules.push(normalized);
    this.persistState();
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
    this.approveEligibleHeldActions(missionId);
    const applied: HeldActionRecord[] = [];
    for (const record of this.listHeldActions(missionId)) {
      if (record.status !== 'approved') continue;
      const appliedRecord = await this.applyHeldAction(record.id);
      applied.push(appliedRecord);
      if (appliedRecord.status === 'failed') break;
    }
    return applied;
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
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    if (
      record.status === 'applied' ||
      record.status === 'rejected' ||
      record.status === 'cancelled'
    )
      return record;
    if (record.status !== 'approved')
      throw new Error(`[POLICY_VIOLATION] Held action ${id} is not approved`);
    const by = assertNonEmpty(record.resolvedBy || '', 'resolvedBy');
    record.resolvedBy = by;
    try {
      const refs = this.resolvedProvisionalRefs(record.missionId);
      record.result = await record.apply(
        resolveProvisionalReferences(record.params, refs) as never,
        refs
      );
      record.status = 'applied';
      record.appliedAt = new Date().toISOString();
      audit('held_action', 'apply', 'completed', {
        heldActionId: id,
        resolvedBy: by,
        autoApproved: record.autoApproved,
      });
    } catch (error) {
      record.status = 'failed';
      record.applyError = error instanceof Error ? error.message : String(error);
      audit('held_action', 'apply', 'failed', { heldActionId: id, error: record.applyError });
    }
    this.persistState();
    return record;
  }

  async revertHeldAction(id: string): Promise<HeldActionRecord> {
    const record = this.held.get(id);
    if (!record) throw new Error(`Held action not found: ${id}`);
    if (record.status !== 'applied' || !record.revert)
      throw new Error(`[POLICY_VIOLATION] Held action ${id} is not revertible`);
    await record.revert(record.result, record.previousState);
    record.status = 'cancelled';
    audit('held_action', 'revert', 'completed', { heldActionId: id });
    this.persistState();
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
    const introduction = { ...input, id: randomUUID(), grantedAt: new Date().toISOString() };
    this.introductions.set(introduction.id, introduction);
    audit('resource_introduction', 'grant', 'completed', introduction);
    this.persistState();
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

  revokeIntroduction(id: string, revokedBy: string): void {
    const entry = this.introductions.get(id);
    if (!entry) throw new Error(`Resource introduction not found: ${id}`);
    if (!entry.revokedAt) entry.revokedAt = new Date().toISOString();
    audit('resource_introduction', 'revoke', 'completed', { id, revokedBy });
    this.persistState();
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
    const record = { ...input, id: randomUUID(), observedAt: new Date().toISOString() };
    this.observations.push(record);
    audit('observation', 'read', 'completed', record);
    this.persistState();
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
    const missingTenant = taint.tenants.length > 0 && !targetTenant;
    const wrongTenant = Boolean(
      targetTenant && taint.tenants.length > 0 && !taint.tenants.includes(targetTenant)
    );
    const denied =
      targetAudience === 'external'
        ? true
        : Boolean(
            missingTenant || wrongTenant || TIER_RANK[targetAudience] < TIER_RANK[taint.highestTier]
          );
    if (denied) {
      audit('provenance', 'egress', 'denied', { missionId, targetAudience, targetTenant, taint });
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
    this.persistState();
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
    this.persistState();
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
      grantedAt: new Date().toISOString(),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.missionId ? { missionId: options.missionId } : {}),
      ...(options.targetAudience ? { targetAudience: options.targetAudience } : {}),
      ...(options.targetTenant ? { targetTenant: options.targetTenant } : {}),
    };
    this.capabilities.set(edge.id, edge);
    audit('capability', 'grant', 'completed', edge);
    this.persistState();
    return edge;
  }

  revokeCapability(id: string, revokedBy: string): void {
    const edge = this.capabilities.get(id);
    if (!edge) throw new Error(`Capability edge not found: ${id}`);
    edge.revokedAt ||= new Date().toISOString();
    audit('capability', 'revoke', 'completed', { id, revokedBy });
    this.persistState();
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
        inputSchema: schemaToJsonSchema(operation.inputSchema),
        outputSchema: schemaToJsonSchema(operation.outputSchema),
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
    this.persistState();
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
        inputSchema: schemaToJsonSchema(operation.inputSchema),
        outputSchema: schemaToJsonSchema(operation.outputSchema),
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
    this.persistState();
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

  private cancelDependents(rejected: HeldActionRecord): void {
    const cancelled = new Set<string>([rejected.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of this.listHeldActions(rejected.missionId)) {
        if (entry.id === rejected.id || entry.status !== 'pending') continue;
        const dependsOnRejected = entry.dependsOn.some((dependency) => cancelled.has(dependency));
        const referencesRejectedProvisional =
          (entry.params as unknown) &&
          rejected.simulation?.provisionalRefs.some((ref) =>
            JSON.stringify(entry.params).includes(ref)
          );
        if (dependsOnRejected || referencesRejectedProvisional) {
          entry.status = 'cancelled';
          cancelled.add(entry.id);
          changed = true;
          audit('held_action', 'cascade_cancel', 'completed', {
            heldActionId: entry.id,
            dependsOn: rejected.id,
          });
        }
      }
    }
    this.persistState();
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
    record.decidedAt = new Date().toISOString();
    audit('held_action', 'decide', 'completed', {
      heldActionId: record.id,
      decision: 'approved',
      resolvedBy: record.resolvedBy,
      autoApproved: true,
    });
    this.persistState();
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

  private persistState(): void {
    if (!this.persist) return;
    const directory = pathResolver.shared('runtime/cloudflare-os');
    safeMkdir(directory, { recursive: true });
    const state: PersistedControlPlaneState = {
      version: 1,
      // Executor parameters may contain credentials or personal payloads. A
      // restored action is deliberately fail-closed until a governed adapter
      // rehydrates its executor and parameters.
      held: [...this.held.values()].map(({ apply, simulate, revert, params, ...record }) => record),
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
      network: [...this.network],
      gadgets: [...this.gadgetManifests.values()].flatMap((manifest) => {
        const operations = this.gadgetOperations.get(manifest.id);
        if (!operations) return [];
        return [
          {
            manifest,
            operations: [...operations.values()].map((operation) => ({
              name: operation.name,
              description: operation.description,
              inputSchema: schemaToJsonSchema(operation.inputSchema),
              outputSchema: schemaToJsonSchema(operation.outputSchema),
              effect: operation.effect,
              capabilityResource: operation.capabilityResource,
              introduction: operation.introduction,
              observation: operation.observation,
              governedCode: operation.governedCode,
            })),
          },
        ];
      }),
    };
    safeWriteFile(this.statePath, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
  }

  private restoreState(): void {
    if (!safeExistsSync(this.statePath)) return;
    try {
      const state = readJson<PersistedControlPlaneState>(this.statePath);
      if (state.version !== 1) return;
      for (const raw of state.held || []) {
        const record = raw as unknown as HeldActionRecord;
        record.apply = () => {
          throw new Error(
            `[CONTROL_PLANE] Executor for persisted op '${record.op}' must be registered after restart`
          );
        };
        record.simulate = undefined;
        record.revert = undefined;
        record.dependsOn ||= [];
        record.effectBinding ||= record.op;
        record.params = undefined as never;
        this.held.set(record.id, record);
      }
      for (const entry of state.introductions || []) this.introductions.set(entry.id, entry);
      this.observations.push(...(state.observations || []));
      this.autoRules.push(...(state.autoRules || []));
      for (const edge of state.capabilities || []) this.capabilities.set(edge.id, edge);
      for (const [threadId, capabilities] of Object.entries(state.threadCapabilities || {})) {
        this.threadCapabilities.set(threadId, new Set(capabilities));
      }
      for (const blueprint of state.blueprints || []) this.blueprints.set(blueprint.id, blueprint);
      for (const gadget of state.gadgets || []) {
        if (!gadget?.manifest?.id || !Array.isArray(gadget.operations)) continue;
        const operations = gadget.operations.map((operation) => ({
          ...operation,
          inputSchema: fromJSONSchema(
            operation.inputSchema as Parameters<typeof fromJSONSchema>[0]
          ),
          outputSchema: fromJSONSchema(
            operation.outputSchema as Parameters<typeof fromJSONSchema>[0]
          ),
        })) as GadgetOperationDefinition<any, any>[];
        this.gadgetManifests.set(gadget.manifest.id, gadget.manifest);
        this.gadgetCapabilitySubjects.set(gadget.manifest.id, gadget.manifest.capabilitySubject);
        this.gadgetOperations.set(
          gadget.manifest.id,
          new Map(operations.map((operation) => [operation.name, operation]))
        );
      }
      this.network.push(...(state.network || []));
    } catch (error) {
      if (this.auditRestoreFailures) {
        audit('control_plane', 'restore', 'failed', {
          statePath: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Observation writers and readers may live in separate long-running
   * processes (for example service-actuator and Chronos). Refresh only the
   * observation projection before provenance reads so a resolver does not
   * keep using the constructor-time snapshot.
   */
  private refreshPersistedObservations(): void {
    if (!this.persist || !safeExistsSync(this.statePath)) return;
    try {
      const state = readJson<PersistedControlPlaneState>(this.statePath);
      if (state.version !== 1 || !Array.isArray(state.observations)) return;
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

function resolveProvisionalReferences(value: unknown, refs: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    let resolved = value;
    for (const [provisional, actual] of refs) {
      if (resolved === provisional) return actual;
      resolved = resolved.replaceAll(provisional, String(actual));
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveProvisionalReferences(entry, refs));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveProvisionalReferences(entry, refs),
      ])
    );
  }
  return value;
}

function summarizeHeldAction(record: HeldActionRecord): HeldActionSummary {
  return {
    id: record.id,
    missionId: record.missionId,
    taskId: record.taskId,
    tenantSlug: record.tenantSlug,
    submittedBy: record.submittedBy,
    op: record.op,
    status: record.status,
    submittedAt: record.submittedAt,
    decidedAt: record.decidedAt,
    resolvedBy: record.resolvedBy,
    autoApproved: record.autoApproved,
    appliedAt: record.appliedAt,
    failureRecorded: Boolean(record.applyError),
    effectBinding: record.effectBinding,
    payloadHash: record.payloadHash,
    dependsOn: [...record.dependsOn],
    actionTag: record.actionTag,
    irreversible: record.irreversible,
    simulatable: Boolean(record.simulation || record.simulatable),
    provisionalRefs: [...(record.simulation?.provisionalRefs || [])],
  };
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
