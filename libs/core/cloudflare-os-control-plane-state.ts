import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type {
  AutoApproveRule,
  BlueprintContract,
  CapabilityEdge,
  GadgetManifest,
  GadgetOperationDescriptor,
  GadgetOperationEffect,
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
      'submittedBy',
      'op',
      'simulatable',
      'autoApprovable',
      'actionTag',
      'irreversible',
      'previousState',
      'status',
      'submittedAt',
      'decidedAt',
      'resolvedBy',
      'autoApproved',
      'appliedAt',
      'result',
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
  };
  if (typeof normalized.autoApproved !== 'boolean') {
    throw new Error(`${label} has invalid required fields`);
  }
  for (const field of ['taskId', 'actionTag', 'resolvedBy'] as const) {
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
  };
}
