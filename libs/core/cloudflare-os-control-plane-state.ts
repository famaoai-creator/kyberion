import { z } from 'zod';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type {
  AutoApproveRule,
  BlueprintContract,
  CapabilityEdge,
  GadgetManifest,
  GadgetOperationDefinition,
  GadgetOperationDescriptor,
  GadgetOperationEffect,
  HeldActionRecord,
  HeldActionStatus,
  NetworkObservation,
  ObservationRecord,
  OsKnowledgeTier,
  ResourceScope,
  ResourceIntroduction,
} from './cloudflare-os-control-plane.js';

export interface PersistedControlPlaneState {
  version: 1;
  held: Array<Record<string, unknown>>;
  introductions: ResourceIntroduction[];
  observations: ObservationRecord[];
  autoRules: AutoApproveRule[];
  capabilities: CapabilityEdge[];
  threadCapabilities: Record<string, string[]>;
  blueprints: BlueprintContract[];
  declassifications?: DeclassificationGrant[];
  network: NetworkObservation[];
  gadgets: PersistedGadget[];
}

interface PersistedGadget {
  manifest: GadgetManifest;
  operations: Array<GadgetOperationDescriptor & { governedCode: string }>;
}

const CONTROL_PLANE_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/cloudflare-os-control-plane-state.schema.json'
);

function controlPlaneStateCatalogAtPath(filePath: string) {
  return defineCatalog<Record<string, unknown>>({
    id: 'cloudflare-os-control-plane-state',
    path: filePath,
    schema: CONTROL_PLANE_STATE_SCHEMA_PATH,
  });
}

/** Load and fully validate a persisted control-plane projection. */
export function loadPersistedControlPlaneStateAtPath(
  filePath: string
): PersistedControlPlaneState | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
  return parsePersistedControlPlaneState(controlPlaneStateCatalogAtPath(safePath).load());
}

/** Validate a state envelope before a control-plane caller persists it. */
export function validatePersistedControlPlaneStateAtPath(filePath: string, value: unknown): void {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const schemaValidated = controlPlaneStateCatalogAtPath(safePath).validate(value, safePath);
  parsePersistedControlPlaneState(schemaValidated);
}

type PersistedRecord = Record<string, unknown>;

const HELD_ACTION_STATUSES = new Set<HeldActionStatus>([
  'pending',
  'approved',
  'applied',
  'rejected',
  'cancelled',
  'failed',
]);
const PERSISTED_STATE_ROOT_FIELDS = [
  'version',
  'held',
  'introductions',
  'observations',
  'autoRules',
  'capabilities',
  'threadCapabilities',
  'blueprints',
  'network',
  'gadgets',
  'declassifications',
] as const;

function persistedRecord(value: unknown, label: string): PersistedRecord {
  return parseSafeJsonObjectValue(value, label);
}

function assertPersistedFields(
  record: PersistedRecord,
  fields: readonly string[],
  label: string
): void {
  const allowed = new Set(fields);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
}

function persistedString(record: PersistedRecord, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function persistedOptionalString(
  record: PersistedRecord,
  field: string,
  label: string
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label}.${field} must be a string`);
  return value;
}

function persistedTimestamp(
  record: PersistedRecord,
  field: string,
  label: string
): string | undefined {
  const value = persistedOptionalString(record, field, label);
  if (value !== undefined && Number.isNaN(Date.parse(value))) {
    throw new Error(`${label}.${field} must be a valid timestamp`);
  }
  return value;
}

function persistedRequiredTimestamp(record: PersistedRecord, field: string, label: string): string {
  const value = persistedTimestamp(record, field, label);
  if (value === undefined) throw new Error(`${label}.${field} must be a valid timestamp`);
  return value;
}

function persistedStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function persistedOptionalStringMap(
  value: unknown,
  label: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = persistedRecord(value, label);
  const entries = Object.entries(record);
  if (entries.some(([key, entry]) => key.trim() === '' || typeof entry !== 'string')) {
    throw new Error(`${label} must map strings to strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parsePersistedHeldAction(value: unknown, index: number): PersistedRecord {
  const label = `control-plane state held[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(
    record,
    [
      'id',
      'missionId',
      'taskId',
      'tenantSlug',
      'submittedBy',
      'op',
      'simulatable',
      'autoApprovable',
      'actionTag',
      'irreversible',
      'previousState',
      'status',
      'submittedAt',
      'params',
      'persistParams',
      'applyClaim',
      'approvalRequest',
      'decidedAt',
      'resolvedBy',
      'autoApproved',
      'appliedAt',
      'result',
      'applyError',
      'simulation',
      'effectBinding',
      'payloadHash',
      'dependsOn',
    ],
    label
  );
  const status = persistedString(record, 'status', label) as HeldActionStatus;
  if (!HELD_ACTION_STATUSES.has(status)) throw new Error(`${label}.status is invalid`);
  const normalized: PersistedRecord = {
    id: persistedString(record, 'id', label),
    missionId: persistedString(record, 'missionId', label),
    submittedBy: persistedString(record, 'submittedBy', label),
    op: persistedString(record, 'op', label),
    status,
    submittedAt: persistedRequiredTimestamp(record, 'submittedAt', label),
    autoApproved: record.autoApproved,
    effectBinding: persistedString(record, 'effectBinding', label),
    payloadHash: persistedString(record, 'payloadHash', label),
    dependsOn:
      record.dependsOn === undefined
        ? []
        : persistedStringArray(record.dependsOn, `${label}.dependsOn`),
    ...(record.params !== undefined ? { params: record.params } : {}),
    ...(record.persistParams === true ? { persistParams: true } : {}),
  };
  if (record.applyClaim !== undefined) {
    const claim = persistedRecord(record.applyClaim, `${label}.applyClaim`);
    assertPersistedFields(claim, ['by', 'at'], `${label}.applyClaim`);
    normalized.applyClaim = {
      by: persistedString(claim, 'by', `${label}.applyClaim`),
      at: persistedString(claim, 'at', `${label}.applyClaim`),
    };
  }
  if (record.approvalRequest !== undefined) {
    const link = persistedRecord(record.approvalRequest, `${label}.approvalRequest`);
    assertPersistedFields(
      link,
      ['requestId', 'storageChannel', 'role'],
      `${label}.approvalRequest`
    );
    normalized.approvalRequest = {
      requestId: persistedString(link, 'requestId', `${label}.approvalRequest`),
      storageChannel: persistedString(link, 'storageChannel', `${label}.approvalRequest`),
      role: persistedString(link, 'role', `${label}.approvalRequest`),
    };
  }
  if (typeof normalized.autoApproved !== 'boolean') {
    throw new Error(`${label} has invalid required fields`);
  }
  for (const field of ['taskId', 'tenantSlug', 'actionTag', 'resolvedBy', 'applyError'] as const) {
    const value = persistedOptionalString(record, field, label);
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['decidedAt', 'appliedAt'] as const) {
    const value = persistedTimestamp(record, field, label);
    if (value !== undefined) normalized[field] = value;
  }
  for (const field of ['simulatable', 'autoApprovable', 'irreversible'] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${label}.${field} must be a boolean`);
    }
    if (value !== undefined) normalized[field] = value;
  }
  if (record.simulation !== undefined) {
    const simulation = persistedRecord(record.simulation, `${label}.simulation`);
    assertPersistedFields(
      simulation,
      ['provisionalRefs', 'value', 'simulated'],
      `${label}.simulation`
    );
    if (simulation.simulated !== true)
      throw new Error(`${label}.simulation.simulated must be true`);
    normalized.simulation = {
      provisionalRefs: persistedStringArray(
        simulation.provisionalRefs,
        `${label}.simulation.provisionalRefs`
      ),
      value: simulation.value,
      simulated: true,
    };
  }
  for (const field of ['previousState', 'result'] as const) {
    if (Object.hasOwn(record, field)) normalized[field] = record[field];
  }
  return normalized;
}

function parsePersistedIntroduction(value: unknown, index: number): ResourceIntroduction {
  const label = `control-plane state introductions[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(
    record,
    [
      'id',
      'missionId',
      'taskId',
      'requestedBy',
      'service',
      'resourceRef',
      'scope',
      'grantedBy',
      'grantedAt',
      'expiresAt',
      'revokedAt',
    ],
    label
  );
  const scope = persistedString(record, 'scope', label) as ResourceScope;
  if (scope !== 'read' && scope !== 'write') throw new Error(`${label}.scope is invalid`);
  persistedOptionalString(record, 'requestedBy', label);
  return {
    id: persistedString(record, 'id', label),
    missionId: persistedString(record, 'missionId', label),
    ...(persistedOptionalString(record, 'taskId', label)
      ? { taskId: persistedOptionalString(record, 'taskId', label) }
      : {}),
    service: persistedString(record, 'service', label),
    resourceRef: persistedString(record, 'resourceRef', label),
    scope,
    grantedBy: persistedString(record, 'grantedBy', label),
    grantedAt: persistedRequiredTimestamp(record, 'grantedAt', label),
    ...(persistedTimestamp(record, 'expiresAt', label)
      ? { expiresAt: persistedTimestamp(record, 'expiresAt', label) }
      : {}),
    ...(persistedTimestamp(record, 'revokedAt', label)
      ? { revokedAt: persistedTimestamp(record, 'revokedAt', label) }
      : {}),
  };
}

function parsePersistedObservation(value: unknown, index: number): ObservationRecord {
  const label = `control-plane state observations[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(
    record,
    [
      'id',
      'missionId',
      'taskId',
      'service',
      'resourceRef',
      'tier',
      'tenantSlug',
      'purpose',
      'summary',
      'observedAt',
      'observedBy',
    ],
    label
  );
  const tier = persistedString(record, 'tier', label) as OsKnowledgeTier;
  if (tier !== 'personal' && tier !== 'confidential' && tier !== 'public') {
    throw new Error(`${label}.tier is invalid`);
  }
  return {
    id: persistedString(record, 'id', label),
    missionId: persistedString(record, 'missionId', label),
    ...(persistedOptionalString(record, 'taskId', label)
      ? { taskId: persistedOptionalString(record, 'taskId', label) }
      : {}),
    service: persistedString(record, 'service', label),
    resourceRef: persistedString(record, 'resourceRef', label),
    tier,
    ...(persistedOptionalString(record, 'tenantSlug', label)
      ? { tenantSlug: persistedOptionalString(record, 'tenantSlug', label) }
      : {}),
    purpose: persistedString(record, 'purpose', label),
    summary: persistedString(record, 'summary', label),
    observedAt: persistedRequiredTimestamp(record, 'observedAt', label),
    ...(persistedOptionalString(record, 'observedBy', label)
      ? { observedBy: persistedOptionalString(record, 'observedBy', label) }
      : {}),
  };
}

function parsePersistedAutoRule(value: unknown, index: number): AutoApproveRule {
  const label = `control-plane state autoRules[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(record, ['op', 'actionTag', 'enabledBy', 'enabledAt'], label);
  const enabledBy = persistedString(record, 'enabledBy', label);
  if (!enabledBy.startsWith('human:')) throw new Error(`${label}.enabledBy must be a human actor`);
  return {
    op: persistedString(record, 'op', label),
    actionTag: persistedString(record, 'actionTag', label),
    enabledBy,
    enabledAt: persistedRequiredTimestamp(record, 'enabledAt', label),
  };
}

function parsePersistedCapability(value: unknown, index: number): CapabilityEdge {
  const label = `control-plane state capabilities[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(
    record,
    [
      'id',
      'subject',
      'resource',
      'scope',
      'grantedAt',
      'revokedAt',
      'parentId',
      'missionId',
      'targetAudience',
      'targetTenant',
    ],
    label
  );
  const scope = persistedString(record, 'scope', label) as ResourceScope;
  if (scope !== 'read' && scope !== 'write') throw new Error(`${label}.scope is invalid`);
  const targetAudience = persistedOptionalString(record, 'targetAudience', label) as
    OsKnowledgeTier | 'external' | undefined;
  if (
    targetAudience !== undefined &&
    !['personal', 'confidential', 'public', 'external'].includes(targetAudience)
  ) {
    throw new Error(`${label}.targetAudience is invalid`);
  }
  return {
    id: persistedString(record, 'id', label),
    subject: persistedString(record, 'subject', label),
    resource: persistedString(record, 'resource', label),
    scope,
    grantedAt: persistedRequiredTimestamp(record, 'grantedAt', label),
    ...(persistedTimestamp(record, 'revokedAt', label)
      ? { revokedAt: persistedTimestamp(record, 'revokedAt', label) }
      : {}),
    ...(persistedOptionalString(record, 'parentId', label)
      ? { parentId: persistedOptionalString(record, 'parentId', label) }
      : {}),
    ...(persistedOptionalString(record, 'missionId', label)
      ? { missionId: persistedOptionalString(record, 'missionId', label) }
      : {}),
    ...(targetAudience ? { targetAudience } : {}),
    ...(persistedOptionalString(record, 'targetTenant', label)
      ? { targetTenant: persistedOptionalString(record, 'targetTenant', label) }
      : {}),
  };
}

function parsePersistedBlueprint(value: unknown, index: number): BlueprintContract {
  const label = `control-plane state blueprints[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(record, ['id', 'required_bindings', 'vocabulary', 'fingerprint'], label);
  if (!Array.isArray(record.required_bindings))
    throw new Error(`${label}.required_bindings must be an array`);
  const required_bindings = record.required_bindings.map((candidate, bindingIndex) => {
    const bindingLabel = `${label}.required_bindings[${bindingIndex}]`;
    const binding = persistedRecord(candidate, bindingLabel);
    assertPersistedFields(binding, ['name', 'service', 'preset', 'secret'], bindingLabel);
    return {
      name: persistedString(binding, 'name', bindingLabel),
      service: persistedString(binding, 'service', bindingLabel),
      ...(persistedOptionalString(binding, 'preset', bindingLabel)
        ? { preset: persistedOptionalString(binding, 'preset', bindingLabel) }
        : {}),
      ...(persistedOptionalString(binding, 'secret', bindingLabel)
        ? { secret: persistedOptionalString(binding, 'secret', bindingLabel) }
        : {}),
    };
  });
  return {
    id: persistedString(record, 'id', label),
    required_bindings,
    ...(persistedOptionalStringMap(record.vocabulary, `${label}.vocabulary`)
      ? { vocabulary: persistedOptionalStringMap(record.vocabulary, `${label}.vocabulary`) }
      : {}),
    ...(persistedOptionalString(record, 'fingerprint', label)
      ? { fingerprint: persistedOptionalString(record, 'fingerprint', label) }
      : {}),
  };
}

function parsePersistedNetwork(value: unknown, index: number): NetworkObservation {
  const label = `control-plane state network[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(record, ['destination', 'allowed', 'reason'], label);
  if (typeof record.allowed !== 'boolean') throw new Error(`${label}.allowed must be a boolean`);
  return {
    destination: persistedString(record, 'destination', label),
    allowed: record.allowed,
    ...(persistedOptionalString(record, 'reason', label)
      ? { reason: persistedOptionalString(record, 'reason', label) }
      : {}),
  };
}

function parsePersistedOperation(
  value: unknown,
  label: string,
  governedCodeRequired: boolean
): PersistedRecord {
  const record = persistedRecord(value, label);
  assertPersistedFields(
    record,
    [
      'name',
      'description',
      'inputSchema',
      'outputSchema',
      'effect',
      'capabilityResource',
      'introduction',
      'observation',
      ...(governedCodeRequired ? ['governedCode'] : []),
    ],
    label
  );
  const effect = persistedString(record, 'effect', label) as GadgetOperationEffect;
  if (effect !== 'read' && effect !== 'held') throw new Error(`${label}.effect is invalid`);
  const introduction = persistedRecord(record.introduction, `${label}.introduction`);
  assertPersistedFields(introduction, ['service', 'resourceRef'], `${label}.introduction`);
  const observation = persistedRecord(record.observation, `${label}.observation`);
  assertPersistedFields(observation, ['tier', 'purpose', 'summary'], `${label}.observation`);
  const tier = persistedString(observation, 'tier', `${label}.observation`) as OsKnowledgeTier;
  if (!['personal', 'confidential', 'public'].includes(tier))
    throw new Error(`${label}.observation.tier is invalid`);
  const inputSchema = persistedRecord(record.inputSchema, `${label}.inputSchema`);
  const outputSchema = persistedRecord(record.outputSchema, `${label}.outputSchema`);
  if (governedCodeRequired) persistedString(record, 'governedCode', label);
  return {
    name: persistedString(record, 'name', label),
    description: persistedString(record, 'description', label),
    inputSchema,
    outputSchema,
    effect,
    capabilityResource: persistedString(record, 'capabilityResource', label),
    introduction: {
      service: persistedString(introduction, 'service', `${label}.introduction`),
      resourceRef: persistedString(introduction, 'resourceRef', `${label}.introduction`),
    },
    observation: {
      tier,
      purpose: persistedString(observation, 'purpose', `${label}.observation`),
      summary: persistedString(observation, 'summary', `${label}.observation`),
    },
    ...(governedCodeRequired
      ? { governedCode: persistedString(record, 'governedCode', label) }
      : {}),
  };
}

function parsePersistedGadget(value: unknown, index: number): PersistedGadget {
  const label = `control-plane state gadgets[${index}]`;
  const record = persistedRecord(value, label);
  assertPersistedFields(record, ['manifest', 'operations'], label);
  const manifest = persistedRecord(record.manifest, `${label}.manifest`);
  assertPersistedFields(
    manifest,
    [
      'id',
      'blueprintId',
      'bindings',
      'capabilitySubject',
      'tenantSlug',
      'operations',
      'sideEffectsHeld',
      'historyRef',
    ],
    `${label}.manifest`
  );
  if (manifest.sideEffectsHeld !== true || !Array.isArray(manifest.operations)) {
    throw new Error(`${label}.manifest has invalid side-effect contract`);
  }
  const manifestOperations = manifest.operations.map((operation, operationIndex) =>
    parsePersistedOperation(operation, `${label}.manifest.operations[${operationIndex}]`, false)
  );
  if (!Array.isArray(record.operations)) throw new Error(`${label}.operations must be an array`);
  const operations = record.operations.map((operation, operationIndex) =>
    parsePersistedOperation(operation, `${label}.operations[${operationIndex}]`, true)
  );
  const operationNames = new Set(operations.map((operation) => operation.name));
  const manifestOperationNames = new Set(manifestOperations.map((operation) => operation.name));
  if (
    operationNames.size !== operations.length ||
    manifestOperations.length !== operations.length ||
    [...operationNames].some((name) => !manifestOperationNames.has(name))
  ) {
    throw new Error(`${label}.operations must match manifest operations`);
  }
  return {
    manifest: {
      id: persistedString(manifest, 'id', `${label}.manifest`),
      blueprintId: persistedString(manifest, 'blueprintId', `${label}.manifest`),
      bindings: persistedStringArray(manifest.bindings, `${label}.manifest.bindings`),
      capabilitySubject: persistedString(manifest, 'capabilitySubject', `${label}.manifest`),
      tenantSlug: persistedString(manifest, 'tenantSlug', `${label}.manifest`),
      operations: manifestOperations as unknown as GadgetOperationDescriptor[],
      sideEffectsHeld: true,
      historyRef: persistedString(manifest, 'historyRef', `${label}.manifest`),
    },
    operations: operations as unknown as Array<
      GadgetOperationDescriptor & { governedCode: string }
    >,
  };
}

export function parsePersistedControlPlaneState(value: unknown): PersistedControlPlaneState {
  const root = persistedRecord(value, 'control-plane state');
  assertPersistedFields(root, PERSISTED_STATE_ROOT_FIELDS, 'control-plane state');
  if (root.version !== 1) throw new Error('control-plane state version is invalid');
  if (!Array.isArray(root.held)) throw new Error('control-plane state held must be an array');
  if (!Array.isArray(root.introductions))
    throw new Error('control-plane state introductions must be an array');
  if (!Array.isArray(root.observations))
    throw new Error('control-plane state observations must be an array');
  if (!Array.isArray(root.autoRules))
    throw new Error('control-plane state autoRules must be an array');
  if (!Array.isArray(root.capabilities))
    throw new Error('control-plane state capabilities must be an array');
  if (!Array.isArray(root.blueprints))
    throw new Error('control-plane state blueprints must be an array');
  if (!Array.isArray(root.network)) throw new Error('control-plane state network must be an array');
  if (!Array.isArray(root.gadgets)) throw new Error('control-plane state gadgets must be an array');
  const threadCapabilities = persistedRecord(
    root.threadCapabilities,
    'control-plane state threadCapabilities'
  );
  return {
    version: 1,
    held: root.held.map(parsePersistedHeldAction),
    introductions: root.introductions.map(parsePersistedIntroduction),
    observations: root.observations.map(parsePersistedObservation),
    autoRules: root.autoRules.map(parsePersistedAutoRule),
    capabilities: root.capabilities.map(parsePersistedCapability),
    threadCapabilities: Object.fromEntries(
      Object.entries(threadCapabilities).map(([threadId, capabilities]) => [
        threadId,
        persistedStringArray(capabilities, `control-plane state threadCapabilities.${threadId}`),
      ])
    ),
    blueprints: root.blueprints.map(parsePersistedBlueprint),
    network: root.network.map(parsePersistedNetwork),
    gadgets: root.gadgets.map(parsePersistedGadget),
    ...(root.declassifications !== undefined
      ? {
          declassifications: (root.declassifications as unknown[]).map((entry, index) =>
            persistedRecord(entry, `control-plane state declassifications[${index}]`)
          ) as unknown as DeclassificationGrant[],
        }
      : {}),
  };
}

// ---------- SC-03 journal serialization helpers ----------

/**
 * Marker on the executor stub a restored held action carries. A record whose
 * `apply` is the stub has no live executor of its own: the plane resolves one
 * from the executor registry at apply time, or defers.
 */
const RESTORED_EXECUTOR = Symbol.for('kyberion.control-plane.restored-executor');

export function isRestoredExecutorStub(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as unknown as Record<symbol, unknown>)[RESTORED_EXECUTOR] === true
  );
}

/**
 * A restored held action is deliberately fail-closed: executor, simulator
 * and reverter closures are never persisted. The plane re-binds them from the
 * executor registry (`registerExecutor`) when the effect is applied.
 */
export function restoredHeldActionRecord(record: {
  id: string;
  op: string;
  dependsOn?: string[];
  effectBinding?: string;
  apply?: unknown;
  simulate?: unknown;
  revert?: unknown;
  params?: unknown;
}): void {
  const stub = () => {
    throw new Error(
      `[CONTROL_PLANE] Executor for persisted op '${record.op}' must be registered after restart`
    );
  };
  (stub as unknown as Record<symbol, unknown>)[RESTORED_EXECUTOR] = true;
  record.apply = stub;
  record.simulate = undefined;
  record.revert = undefined;
  record.dependsOn ||= [];
  record.effectBinding ||= record.op;
}

/**
 * Strip executable state a journal or snapshot must never carry. `params`
 * may hold credentials or personal payloads, so it persists only when the
 * submitter declared `persistParams` (validated at submit): everything else
 * stays in the submitting process's memory.
 */
export function serializableHeldActionRecord(
  record: Record<string, unknown>
): Record<string, unknown> {
  const { apply, simulate, revert, steeringApproval, params, ...rest } = record;
  return record.persistParams === true && params !== undefined ? { ...rest, params } : rest;
}

/**
 * The in-memory collections a journal event folds into — the plane passes
 * its own maps so replay, catch-up and restore share one code path.
 */
export interface DeclassificationGrant {
  id: string;
  missionId: string;
  tenantSlug?: string;
  artifactRef: string;
  payloadHash: string;
  targetAudience: string;
  targetTenant?: string;
  grantedBy: string;
  grantedAt: string;
}

export function declassificationKeyOf(
  grant: Pick<
    DeclassificationGrant,
    'missionId' | 'payloadHash' | 'targetAudience' | 'targetTenant'
  >
): string {
  // The mission is part of the key: two missions granting the same artifact
  // to the same audience must not overwrite each other's grant.
  return `${grant.missionId}|${grant.payloadHash}|${grant.targetAudience}|${grant.targetTenant ?? ''}`;
}

export interface ControlPlaneJournalCollections {
  held: Map<string, HeldActionRecord>;
  introductions: Map<string, ResourceIntroduction>;
  observations: ObservationRecord[];
  autoRules: AutoApproveRule[];
  capabilities: Map<string, CapabilityEdge>;
  threadCapabilities: Map<string, Set<string>>;
  blueprints: Map<string, BlueprintContract>;
  declassifications: Map<string, DeclassificationGrant>;
  network: NetworkObservation[];
  observationAggregates: Map<
    string,
    {
      missionId: string;
      resourceRef: string;
      tier: string;
      tenantSlug?: string;
      count: number;
      firstObservedAt: string;
      lastObservedAt: string;
    }
  >;
  gadgets: {
    manifests: Map<string, GadgetManifest>;
    capabilitySubjects: Map<string, string>;
    operations: Map<string, Map<string, GadgetOperationDefinition>>;
    deserializeOperation: (operation: Record<string, unknown>) => GadgetOperationDefinition;
  };
}

function observationAggregateKeyOf(record: Record<string, unknown>): string {
  return `${record.missionId}|${record.resourceRef}|${record.tier}`;
}

/** Fold one journal event into the in-memory projection (SC-03). */
export function applyControlPlaneJournalEvent(
  collections: ControlPlaneJournalCollections,
  event: { kind: string; records: Record<string, unknown>[]; op?: string }
): void {
  if (event.op === 'delete') {
    // A tombstone only removes the record while it is still unscoped: once it
    // was adopted into a tenant the tenant's copy must survive any replay order.
    for (const raw of event.records) {
      const existing = event.kind === 'held' ? collections.held.get(raw.id as string) : undefined;
      if (existing && !existing.tenantSlug) collections.held.delete(existing.id);
    }
    return;
  }
  for (const raw of event.records) {
    switch (event.kind) {
      case 'held': {
        const record = raw as unknown as HeldActionRecord;
        const previous = collections.held.get(record.id);
        restoredHeldActionRecord(record);
        // A catch-up event (e.g. another process's decision) replaces the
        // record object. Carry over what only this process holds: the live
        // executor closures and any params that were never persisted.
        if (previous && !isRestoredExecutorStub(previous.apply)) {
          record.apply = previous.apply;
          record.simulate = previous.simulate;
          record.revert = previous.revert;
        }
        if (previous && record.params === undefined && previous.params !== undefined) {
          record.params = previous.params;
        }
        collections.held.set(record.id, record);
        break;
      }
      case 'introduction':
        collections.introductions.set(raw.id as string, raw as unknown as ResourceIntroduction);
        break;
      case 'observation': {
        if (!raw.id || !collections.observations.some((entry) => entry.id === raw.id)) {
          collections.observations.push(raw as unknown as ObservationRecord);
          const key = observationAggregateKeyOf(raw);
          const existing = collections.observationAggregates.get(key);
          const observedAt = String(raw.observedAt ?? '');
          if (existing) {
            existing.count += 1;
            if (observedAt < existing.firstObservedAt) existing.firstObservedAt = observedAt;
            if (observedAt > existing.lastObservedAt) existing.lastObservedAt = observedAt;
            if (!existing.tenantSlug && typeof raw.tenantSlug === 'string')
              existing.tenantSlug = raw.tenantSlug;
          } else {
            collections.observationAggregates.set(key, {
              missionId: String(raw.missionId ?? ''),
              resourceRef: String(raw.resourceRef ?? ''),
              tier: String(raw.tier ?? ''),
              ...(typeof raw.tenantSlug === 'string' ? { tenantSlug: raw.tenantSlug } : {}),
              count: 1,
              firstObservedAt: observedAt,
              lastObservedAt: observedAt,
            });
          }
        }
        break;
      }
      case 'auto_rule': {
        const rule = raw as unknown as AutoApproveRule;
        if (
          !collections.autoRules.some(
            (entry) =>
              entry.op === rule.op &&
              entry.actionTag === rule.actionTag &&
              entry.enabledBy === rule.enabledBy
          )
        ) {
          collections.autoRules.push(rule);
        }
        break;
      }
      case 'capability':
        collections.capabilities.set(raw.id as string, raw as unknown as CapabilityEdge);
        break;
      case 'thread_capability': {
        const entry = raw as { threadId: string; capabilities: string[] };
        collections.threadCapabilities.set(entry.threadId, new Set(entry.capabilities));
        break;
      }
      case 'blueprint':
        collections.blueprints.set(raw.id as string, raw as unknown as BlueprintContract);
        break;
      case 'declassification':
        collections.declassifications.set(
          declassificationKeyOf(raw as never),
          raw as unknown as DeclassificationGrant
        );
        break;
      case 'network': {
        const key = JSON.stringify(raw);
        if (!collections.network.some((entry) => JSON.stringify(entry) === key)) {
          collections.network.push(raw as unknown as NetworkObservation);
        }
        break;
      }
      case 'gadget': {
        const gadget = raw as {
          manifest?: GadgetManifest;
          operations?: Array<Record<string, unknown>>;
        };
        if (!gadget?.manifest?.id || !Array.isArray(gadget.operations)) break;
        const operations = gadget.operations.map((operation) =>
          collections.gadgets.deserializeOperation(operation)
        );
        collections.gadgets.manifests.set(gadget.manifest.id, gadget.manifest);
        collections.gadgets.capabilitySubjects.set(
          gadget.manifest.id,
          gadget.manifest.capabilitySubject
        );
        collections.gadgets.operations.set(
          gadget.manifest.id,
          new Map(operations.map((operation) => [operation.name, operation]))
        );
        break;
      }
    }
  }
}

/** zod → persisted JSON schema (drops the $schema marker). */
export function gadgetSchemaToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

/** Rehydrate a persisted gadget operation descriptor's schemas. */
export function deserializeGadgetOperation(
  operation: Record<string, unknown>
): GadgetOperationDefinition {
  return {
    ...operation,
    inputSchema: z.fromJSONSchema(operation.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
    outputSchema: z.fromJSONSchema(
      operation.outputSchema as Parameters<typeof z.fromJSONSchema>[0]
    ),
  } as GadgetOperationDefinition;
}

/** Serialize one gadget manifest + operations for journal/snapshot write. */
export function serializeGadgetRecord(
  manifest: GadgetManifest,
  operations: Map<string, GadgetOperationDefinition> | undefined
): PersistedGadget {
  return {
    manifest,
    operations: operations
      ? [...operations.values()].map((operation) => ({
          name: operation.name,
          description: operation.description,
          inputSchema: gadgetSchemaToJsonSchema(operation.inputSchema),
          outputSchema: gadgetSchemaToJsonSchema(operation.outputSchema),
          effect: operation.effect,
          capabilityResource: operation.capabilityResource,
          introduction: operation.introduction,
          observation: operation.observation,
          governedCode: operation.governedCode,
        }))
      : [],
  };
}

/**
 * Fold a whole persisted state (the legacy single-file layout) into the
 * in-memory collections through the same per-kind code path a journal replay
 * uses, so the two persistence modes cannot drift apart.
 */
export function foldPersistedState(
  collections: ControlPlaneJournalCollections,
  state: PersistedControlPlaneState
): void {
  const as = (value: unknown) => (value ?? []) as Record<string, unknown>[];
  const batches: Array<[string, Record<string, unknown>[]]> = [
    ['held', as(state.held)],
    ['introduction', as(state.introductions)],
    ['observation', as(state.observations)],
    ['auto_rule', as(state.autoRules)],
    ['capability', as(state.capabilities)],
    [
      'thread_capability',
      Object.entries(state.threadCapabilities ?? {}).map(([threadId, capabilities]) => ({
        threadId,
        capabilities,
      })),
    ],
    ['blueprint', as(state.blueprints)],
    ['declassification', as(state.declassifications)],
    ['gadget', as(state.gadgets)],
    ['network', as(state.network)],
  ];
  for (const [kind, records] of batches) {
    if (records.length > 0) applyControlPlaneJournalEvent(collections, { kind, records });
  }
}
