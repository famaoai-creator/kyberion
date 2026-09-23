import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { suggestClosestStrings } from './op-suggestions.js';
import { isSafeActuatorId, loadActuatorManifestCatalog } from './src/actuator-manifest-index.js';
import { assertCapabilityAllowed } from './capability-restriction-policy.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type PipelineStepType = 'capture' | 'transform' | 'apply' | 'control';

export interface ResolvedActuatorOperation {
  domain: string;
  action: string;
  actuatorId: string;
  modulePath: string;
  stepType: PipelineStepType;
  source: 'actuator-op-registry' | 'plugin' | 'scenario-fixture';
  manifestPath: string;
  /** Governed per-operation budget, when the op definition declares one. */
  timeoutMs?: number;
  pluginId?: string;
  handler?: ActuatorOperationHandler;
}

export type ActuatorOperationHandler = (
  op: string,
  params: Record<string, unknown>,
  context: Record<string, unknown>,
  stepType: PipelineStepType,
  trace?: unknown,
  policy?: unknown
) => Promise<{ handled: boolean; ctx: Record<string, unknown> }>;

interface DomainOpRegistry {
  capture?: string[];
  transform?: string[];
  apply?: string[];
  control?: string[];
}

export interface ActuatorOpRegistryFile {
  version?: string;
  description?: string;
  shared_capture_ops: string[];
  shared_transform_ops: string[];
  shared_apply_ops: string[];
  operation_timeouts_ms?: Record<string, number>;
  domains: Record<string, DomainOpRegistry>;
}

let _cachedOpRegistry: ActuatorOpRegistryFile | null = null;
const DEFAULT_CONTROL_OPS = [
  'if',
  'while',
  'loop_until',
  'retry_until_quality',
  'foreach',
  'parallel_foreach',
  'team_lead',
  'parallel_calls',
  'accumulate',
  'include',
  'judge_route',
  'await_decision',
];

const pluginOperations = new Map<string, ResolvedActuatorOperation>();

const actuatorOpCatalog = defineCatalog<ActuatorOpRegistryFile>({
  id: 'actuator-op-registry',
  path: pathResolver.knowledge('product/governance/actuator-op-registry.json'),
  schema: pathResolver.knowledge('product/schemas/actuator-op-registry.schema.json'),
});

export function registerPluginActuatorOperation(input: {
  domain: string;
  action: string;
  stepType: Exclude<PipelineStepType, 'control'>;
  pluginId: string;
  modulePath: string;
  handler: ActuatorOperationHandler;
  timeoutMs?: number;
}): () => void {
  const domain = input.domain.trim();
  const action = input.action.trim();
  const pluginId = input.pluginId.trim();
  if (!domain || !action || !pluginId || !input.modulePath.trim()) {
    throw new Error(
      '[OP_REGISTRY_PLUGIN_CONFIG] domain, action, pluginId, and modulePath are required'
    );
  }
  const key = `${domain}:${action}`;
  if (pluginOperations.has(key)) {
    throw new Error(`[OP_REGISTRY_PLUGIN_CONFIG] duplicate plugin operation: ${key}`);
  }
  const resolved: ResolvedActuatorOperation = {
    domain,
    action,
    actuatorId: pluginId,
    modulePath: input.modulePath,
    stepType: input.stepType,
    source: 'plugin',
    manifestPath: input.modulePath,
    pluginId,
    handler: input.handler,
    ...(isValidTimeoutMs(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
  };
  pluginOperations.set(key, resolved);
  return () => {
    if (pluginOperations.get(key) === resolved) pluginOperations.delete(key);
  };
}

export function listPluginActuatorOperations(): readonly ResolvedActuatorOperation[] {
  return [...pluginOperations.values()].sort((left, right) =>
    `${left.domain}:${left.action}`.localeCompare(`${right.domain}:${right.action}`)
  );
}

export function resetPluginActuatorOperationsForTests(): void {
  pluginOperations.clear();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function operationTimeoutMs(domain: string, action: string): number | undefined {
  const plugin = pluginOperations.get(`${domain}:${action}`);
  if (plugin?.timeoutMs !== undefined) return plugin.timeoutMs;
  const declared = loadActuatorOpRegistry().operation_timeouts_ms?.[`${domain}:${action}`];
  return isValidTimeoutMs(declared) ? declared : undefined;
}

/** Return the declared budget without resolving/importing an actuator. */
export function resolveActuatorOperationTimeout(
  domain: string,
  action: string
): number | undefined {
  return operationTimeoutMs(domain.trim(), action.trim());
}

function collectKnownOps(domain: string, registry: ActuatorOpRegistryFile): string[] {
  const domainRegistry = registry.domains[domain];
  return unique([
    ...(domainRegistry?.capture ?? []),
    ...(domainRegistry?.transform ?? []),
    ...(domainRegistry?.apply ?? []),
    ...registry.shared_capture_ops,
    ...registry.shared_transform_ops,
    ...registry.shared_apply_ops,
  ]);
}

export function loadActuatorOpRegistry(): ActuatorOpRegistryFile {
  if (_cachedOpRegistry) return _cachedOpRegistry;
  _cachedOpRegistry = actuatorOpCatalog.load();
  return _cachedOpRegistry;
}

export function listKnownActuatorOps(domain: string, extraOps: string[] = []): string[] {
  const registry = loadActuatorOpRegistry();
  return unique([
    ...collectKnownOps(domain, registry),
    ...listPluginActuatorOperations()
      .filter((entry) => entry.domain === domain)
      .map((entry) => entry.action),
    ...extraOps,
  ]);
}

export function buildUnknownActuatorOpError(
  domain: string,
  action: string,
  extraOps: string[] = DEFAULT_CONTROL_OPS
): Error {
  const candidates = listKnownActuatorOps(domain, extraOps);
  const suggestions = suggestClosestStrings(action, candidates);
  return new Error(
    suggestions.length > 0
      ? `[UNKNOWN_OP] Unknown op "${action}" for domain "${domain}". Did you mean: ${suggestions.join(', ')}?`
      : `[UNKNOWN_OP] Unknown op "${action}" for domain "${domain}"`
  );
}

export function determineActuatorStepType(domain: string, action: string): PipelineStepType {
  const plugin = pluginOperations.get(`${domain}:${action}`);
  if (plugin) return plugin.stepType;
  const { shared_capture_ops, shared_transform_ops, shared_apply_ops, domains } =
    loadActuatorOpRegistry();
  const registry = domains[domain];
  if (registry?.apply?.includes(action)) return 'apply';
  if (registry?.capture?.includes(action)) return 'capture';
  if (registry?.transform?.includes(action)) return 'transform';
  if (registry?.control?.includes(action)) return 'control';

  if (shared_capture_ops.includes(action)) return 'capture';
  if (shared_transform_ops.includes(action)) return 'transform';
  if (shared_apply_ops.includes(action)) return 'apply';

  throw buildUnknownActuatorOpError(domain, action);
}

export interface ScenarioOpOverrideRequest {
  /** 'domain:action' */
  op: string;
  domain: string;
  action: string;
  /** 'approval-probe' asks only whether a fixture exists; the override must not record it. */
  purpose: 'dispatch' | 'approval-probe';
}

export interface ScenarioOpOverrideResult {
  handler: ActuatorOperationHandler;
  stepType?: PipelineStepType;
}

/**
 * ES-02: scenario-runner-only op override. `resolve` returns a fixture
 * handler, `undefined` to leave the op on its normal path, or throws to fail
 * closed (e.g. `[SCENARIO_UNSTUBBED_OP]`). `approvalGranted` may only grant
 * an approval for an op that `resolve` serves from a fixture, so a scenario
 * decision can never admit a real side effect.
 */
export interface ScenarioOpOverride {
  resolve(request: ScenarioOpOverrideRequest): ScenarioOpOverrideResult | undefined;
  approvalGranted?(request: ScenarioOpOverrideRequest): boolean;
}

const scenarioOpOverrideSeam = createSeam<ScenarioOpOverride>({
  key: 'scenario-op-override',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const SCENARIO_OVERRIDE_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/scenario-interceptor.ts',
  reason: 'scenario runner op fixtures (never registered in production processes)',
};

/** Bind the scenario op override (sole seam); returns its disposer. */
export function registerScenarioOpOverride(
  override: ScenarioOpOverride,
  metadata: SeamProviderMetadata = SCENARIO_OVERRIDE_METADATA
): () => void {
  return scenarioOpOverrideSeam.register('scenario-runner', override, metadata);
}

export function getScenarioOpOverride(): ScenarioOpOverride | undefined {
  return scenarioOpOverrideSeam.getOptional();
}

function scenarioFixtureStepType(domain: string, action: string): PipelineStepType {
  try {
    return determineActuatorStepType(domain, action);
  } catch {
    return 'apply';
  }
}

/**
 * Resolve an op through the scenario override. `null` when no override is
 * registered or the override leaves the op alone; throws when the override
 * fails the op closed. Capability restrictions still apply to fixture ops.
 */
export function resolveScenarioOpOverride(
  domain: string,
  action: string
): ResolvedActuatorOperation | null {
  const override = scenarioOpOverrideSeam.getOptional();
  if (!override) return null;
  const op = `${domain}:${action}`;
  const result = override.resolve({ op, domain, action, purpose: 'dispatch' });
  if (!result) return null;
  assertCapabilityAllowed([op, domain]);
  return {
    domain,
    action,
    actuatorId: 'scenario-fixture',
    modulePath: `scenario-fixture:${op}`,
    stepType: result.stepType ?? scenarioFixtureStepType(domain, action),
    source: 'scenario-fixture',
    manifestPath: 'scenario-fixture',
    handler: result.handler,
  };
}

/** True only when a registered override grants approval for an op it serves from a fixture. */
export function isScenarioApprovalGranted(domain: string, action: string): boolean {
  const override = scenarioOpOverrideSeam.getOptional();
  if (!override?.approvalGranted) return false;
  const request: ScenarioOpOverrideRequest = {
    op: `${domain}:${action}`,
    domain,
    action,
    purpose: 'approval-probe',
  };
  try {
    if (!override.resolve(request)) return false;
  } catch {
    return false;
  }
  return override.approvalGranted(request) === true;
}

/**
 * DH-05: resolve an operation through the governed op and manifest catalogs.
 * The runner keeps a convention fallback for managed/legacy actuators, but
 * callers can use this result to retain explicit registry provenance.
 */
export function resolveActuatorOperation(
  domain: string,
  action: string
): ResolvedActuatorOperation | null {
  const scenarioOperation = resolveScenarioOpOverride(domain, action);
  if (scenarioOperation) return scenarioOperation;
  const stepType = determineActuatorStepType(domain, action);
  const plugin = pluginOperations.get(`${domain}:${action}`);
  if (plugin) {
    assertCapabilityAllowed([`${domain}:${action}`, plugin.actuatorId, domain]);
    return plugin;
  }
  const expectedIds = new Set([`${domain}-actuator`, domain]);
  const manifest = loadActuatorManifestCatalog().find((entry) => expectedIds.has(entry.n));
  assertCapabilityAllowed([`${domain}:${action}`, manifest?.n || `${domain}-actuator`, domain]);
  if (!manifest) return null;
  const modulePath = resolveActuatorModulePath(manifest.n, manifest.entrypoint || 'src/index.js');
  return {
    domain,
    action,
    actuatorId: manifest.n,
    modulePath,
    stepType,
    source: 'actuator-op-registry',
    manifestPath: manifest.manifest_path,
    ...(operationTimeoutMs(domain, action) !== undefined
      ? { timeoutMs: operationTimeoutMs(domain, action) }
      : {}),
  };
}

/**
 * Convert a manifest entrypoint to the only module path the pipeline may
 * import. Manifest data is governed, but still validated at the import
 * boundary so a malformed or tampered catalog cannot escape the actuator
 * directory through `..` or an absolute path.
 */
export function resolveActuatorModulePath(actuatorId: string, entrypoint: string): string {
  const id = actuatorId.trim();
  const normalized = entrypoint.trim().replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !id ||
    !isSafeActuatorId(id) ||
    !normalized ||
    normalized.startsWith('/') ||
    segments.some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error(`[OP_RESOLUTION_MANIFEST] invalid entrypoint for ${id || 'unknown actuator'}`);
  }
  const jsEntrypoint = normalized.replace(/\.[^./]+$/u, '.js');
  return `dist/libs/actuators/${id}/${jsEntrypoint}`;
}

export function listRegisteredDomainOps(domain: string): DomainOpRegistry {
  const declared = loadActuatorOpRegistry().domains[domain] || {};
  const pluginOps = listPluginActuatorOperations().filter((entry) => entry.domain === domain);
  const merge = (
    stepType: Exclude<PipelineStepType, 'control'>,
    declaredOps: string[] | undefined
  ): string[] | undefined => {
    const contributed = pluginOps
      .filter((entry) => entry.stepType === stepType)
      .map((entry) => entry.action);
    const values = unique([...(declaredOps || []), ...contributed]);
    return values.length > 0 ? values : undefined;
  };
  const capture = merge('capture', declared.capture);
  const transform = merge('transform', declared.transform);
  const apply = merge('apply', declared.apply);
  return {
    ...(capture ? { capture } : {}),
    ...(transform ? { transform } : {}),
    ...(apply ? { apply } : {}),
  };
}
