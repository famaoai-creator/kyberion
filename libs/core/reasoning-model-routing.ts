import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import type {
  ReasoningLevel,
  ReasoningLevelDecision,
  ReasoningLevelPolicy,
} from './reasoning-level-policy.js';
import { loadReasoningLevelPolicy } from './reasoning-level-policy.js';
export { resolveRuntimeModelId, type RuntimeModelRole } from './runtime-model-defaults.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const MODEL_REGISTRY_PATH = pathResolver.knowledge('product/governance/model-registry.json');
const MODEL_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/model-registry.schema.json'
);

type ModelRoleFit = 'primary' | 'secondary' | 'not_recommended';
type ModelStatus = 'approved' | 'candidate' | 'deprecated' | 'blocked';

export interface ModelRegistryEntry {
  model_id: string;
  provider: string;
  family: string;
  status: ModelStatus;
  cost_band?: 'low' | 'medium' | 'high' | 'very_high';
  latency_band?: 'low' | 'medium' | 'high';
  reasoning_confidence?: 'low' | 'medium' | 'high';
  role_fit: {
    intent_compiler: ModelRoleFit;
    surface_agent: ModelRoleFit;
    analysis: ModelRoleFit;
    coding: ModelRoleFit;
  };
}

export interface ModelRegistryFile {
  version: string;
  default_model_id: string;
  models: ModelRegistryEntry[];
}

export interface ReasoningModelRoute {
  recommended_model_id: string | null;
  model_route_status: 'shadow';
  route_reason: string;
  route_kind: 'primary' | 'shadow' | 'none';
  policy_version: string;
}

export type TaskModelTier = 'small' | 'standard' | 'large';
export type TaskModelEffort = 'low' | 'medium' | 'high';

export interface TaskModelHint {
  tier: TaskModelTier;
  effort: TaskModelEffort;
  model_id: string;
  route_reason: string;
}

export interface TaskModelHintInput {
  phase_kind: 'plan' | 'implement' | 'review' | 'mechanical';
  risk?: string;
  estimated_scope?: string;
}

let validateFn: ValidateFunction | null = null;
let cachedRegistry: ModelRegistryFile | null = null;
let cachedRegistryPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, MODEL_REGISTRY_SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function validateRegistry(value: unknown, label = MODEL_REGISTRY_PATH): ModelRegistryFile {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid model registry at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ModelRegistryFile;
}

function loadRegistryFile(): ModelRegistryFile | null {
  if (!safeExistsSync(MODEL_REGISTRY_PATH)) return null;
  const parsed = JSON.parse(safeReadFile(MODEL_REGISTRY_PATH, { encoding: 'utf8' }) as string);
  return validateRegistry(parsed, MODEL_REGISTRY_PATH);
}

export function loadModelRegistry(): ModelRegistryFile {
  if (cachedRegistry && cachedRegistryPath === MODEL_REGISTRY_PATH) return cachedRegistry;
  const registry = loadRegistryFile();
  if (!registry) {
    throw new Error(`Model registry missing at ${MODEL_REGISTRY_PATH}`);
  }
  cachedRegistry = registry;
  cachedRegistryPath = MODEL_REGISTRY_PATH;
  return registry;
}

function findPrimaryIntentCompilerModel(registry: ModelRegistryFile): ModelRegistryEntry {
  const approvedPrimary = registry.models.find(
    (model) => model.status === 'approved' && model.role_fit.intent_compiler === 'primary'
  );
  if (approvedPrimary) return approvedPrimary;

  const fallback = registry.models.find((model) => model.role_fit.intent_compiler === 'primary');
  if (fallback) return fallback;

  throw new Error('Model registry does not contain an eligible primary intent compiler model.');
}

function findEligibleFastModel(
  registry: ModelRegistryFile,
  modelId: string
): ModelRegistryEntry | null {
  const model = registry.models.find((entry) => entry.model_id === modelId);
  if (!model) return null;
  if (
    model.role_fit.intent_compiler !== 'primary' &&
    model.role_fit.intent_compiler !== 'secondary'
  ) {
    return null;
  }
  if (model.status === 'blocked' || model.status === 'deprecated') {
    return null;
  }
  return model;
}

function isEligibleTaskModel(model: ModelRegistryEntry): boolean {
  return model.status !== 'blocked' && model.status !== 'deprecated';
}

function scoreTaskModelStatus(status: ModelStatus): number {
  switch (status) {
    case 'approved':
      return 0;
    case 'candidate':
      return 1;
    case 'deprecated':
      return 2;
    case 'blocked':
      return 3;
  }
}

function findTaskModelForTier(
  registry: ModelRegistryFile,
  tier: TaskModelTier
): ModelRegistryEntry {
  const eligible = registry.models.filter(isEligibleTaskModel);

  if (tier === 'small') {
    const fastLane = eligible
      .filter((model) => model.latency_band === 'low')
      .filter((model) => model.role_fit.intent_compiler !== 'not_recommended')
      .sort(
        (left, right) =>
          scoreTaskModelStatus(left.status) - scoreTaskModelStatus(right.status) ||
          left.latency_band.localeCompare(right.latency_band) ||
          right.reasoning_confidence.localeCompare(left.reasoning_confidence)
      )[0];
    if (fastLane) return fastLane;
  }

  const approvedPrimary = eligible.find(
    (model) => model.status === 'approved' && model.role_fit.intent_compiler === 'primary'
  );
  if (approvedPrimary) return approvedPrimary;

  const primary = eligible.find((model) => model.role_fit.intent_compiler === 'primary');
  if (primary) return primary;

  const secondary = eligible.find((model) => model.role_fit.intent_compiler === 'secondary');
  if (secondary) return secondary;

  throw new Error('Model registry does not contain an eligible task model.');
}

function normalizeScopeTier(estimatedScope?: string): TaskModelTier | undefined {
  const scope = String(estimatedScope || '')
    .trim()
    .toLowerCase();
  if (!scope) return undefined;
  if (['xs', 'extra-small', 'small', 's'].includes(scope)) return 'small';
  if (['m', 'medium'].includes(scope)) return 'standard';
  if (['l', 'large', 'xl', 'extra-large'].includes(scope)) return 'large';
  return undefined;
}

function normalizeRiskTier(risk?: string): TaskModelTier | undefined {
  const normalized = String(risk || '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (['approval_required', 'high_stakes', 'high'].includes(normalized)) return 'large';
  if (normalized === 'low') return 'small';
  return undefined;
}

function tierToEffort(tier: TaskModelTier): TaskModelEffort {
  switch (tier) {
    case 'small':
      return 'low';
    case 'standard':
      return 'medium';
    case 'large':
      return 'high';
  }
}

function tierReason(input: TaskModelHintInput, tier: TaskModelTier): string {
  const parts = [
    `phase_kind=${input.phase_kind}`,
    input.estimated_scope ? `estimated_scope=${input.estimated_scope}` : null,
    input.risk ? `risk=${input.risk}` : null,
  ].filter(Boolean);
  return `${parts.join(', ')} -> ${tier}/${tierToEffort(tier)}`;
}

export function resolveTaskModelHint(
  input: TaskModelHintInput,
  options: { registry?: ModelRegistryFile } = {}
): TaskModelHint {
  const registry = options.registry ?? loadModelRegistry();
  const scopeTier = normalizeScopeTier(input.estimated_scope);
  const riskTier = normalizeRiskTier(input.risk);

  let tier: TaskModelTier;
  if (input.phase_kind === 'mechanical') {
    tier = 'small';
  } else if (input.phase_kind === 'review') {
    tier = 'large';
  } else if (input.phase_kind === 'plan') {
    tier = scopeTier === 'small' ? 'standard' : 'large';
  } else if (input.phase_kind === 'implement') {
    tier =
      riskTier === 'large' || scopeTier === 'large'
        ? 'large'
        : scopeTier === 'small' || riskTier === 'small'
          ? 'small'
          : 'standard';
  } else {
    tier = scopeTier || riskTier || 'standard';
  }

  if (riskTier === 'large') {
    tier = 'large';
  } else if (riskTier === 'small' && tier === 'standard') {
    tier = 'small';
  }

  const model = findTaskModelForTier(registry, tier);
  return {
    tier,
    effort: tierToEffort(tier),
    model_id: model.model_id,
    route_reason: tierReason(input, tier),
  };
}

export function resolveReasoningModelRoute(
  decision: ReasoningLevelDecision,
  options: {
    policy?: ReasoningLevelPolicy;
    registry?: ModelRegistryFile;
  } = {}
): ReasoningModelRoute {
  const policy = options.policy ?? loadReasoningLevelPolicy();
  const registry = options.registry ?? loadModelRegistry();
  const primaryModel = findPrimaryIntentCompilerModel(registry);
  const configuredModelId = policy.shadow_model_map?.[decision.level as ReasoningLevel] || null;

  if (decision.level === 'REFLEX_DETERMINISTIC') {
    return {
      recommended_model_id: null,
      model_route_status: 'shadow',
      route_reason: 'Reflex lane bypasses model dispatch.',
      route_kind: 'none',
      policy_version: policy.version,
    };
  }

  if (decision.level === 'REACTION_FAST') {
    if (!configuredModelId) {
      return {
        recommended_model_id: primaryModel.model_id,
        model_route_status: 'shadow',
        route_reason:
          'No fast-lane shadow model was configured; fell back to the approved primary compiler.',
        route_kind: 'primary',
        policy_version: policy.version,
      };
    }
    const fastModel = findEligibleFastModel(registry, configuredModelId);
    if (!fastModel) {
      return {
        recommended_model_id: primaryModel.model_id,
        model_route_status: 'shadow',
        route_reason: `Configured fast-lane model ${configuredModelId} is missing or ineligible; fell back to ${primaryModel.model_id}.`,
        route_kind: 'primary',
        policy_version: policy.version,
      };
    }
    return {
      recommended_model_id: fastModel.model_id,
      model_route_status: 'shadow',
      route_reason: `Fast lane shadow routes to ${fastModel.model_id}.`,
      route_kind: 'shadow',
      policy_version: policy.version,
    };
  }

  if (configuredModelId && configuredModelId !== primaryModel.model_id) {
    const configuredModel = registry.models.find((entry) => entry.model_id === configuredModelId);
    if (!configuredModel) {
      return {
        recommended_model_id: primaryModel.model_id,
        model_route_status: 'shadow',
        route_reason: `Configured model ${configuredModelId} is missing; using approved primary compiler ${primaryModel.model_id}.`,
        route_kind: 'primary',
        policy_version: policy.version,
      };
    }
    if (
      configuredModel.status !== 'approved' &&
      configuredModel.role_fit.intent_compiler !== 'primary'
    ) {
      return {
        recommended_model_id: primaryModel.model_id,
        model_route_status: 'shadow',
        route_reason: `Configured model ${configuredModelId} is ineligible; using approved primary compiler ${primaryModel.model_id}.`,
        route_kind: 'primary',
        policy_version: policy.version,
      };
    }
  }

  return {
    recommended_model_id: primaryModel.model_id,
    model_route_status: 'shadow',
    route_reason: `Shadow route measures against approved primary compiler ${primaryModel.model_id}.`,
    route_kind: 'primary',
    policy_version: policy.version,
  };
}

export function resetReasoningModelRoutingCache(): void {
  cachedRegistry = null;
  cachedRegistryPath = null;
}
