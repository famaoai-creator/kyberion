import AjvModule, { type ValidateFunction } from 'ajv';

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { type StandardIntentDefinition, type IntentResolutionPacket } from './intent-resolution.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const POLICY_PATH = pathResolver.knowledge('product/governance/reasoning-level-policy.json');
const SCHEMA_PATH = pathResolver.knowledge('product/schemas/reasoning-level-policy.schema.json');

export type ReasoningLevel =
  | 'COGNITIVE_EXPLORATORY'
  | 'COGNITIVE_STANDARD'
  | 'REACTION_FAST'
  | 'REFLEX_DETERMINISTIC';

export interface ReasoningLevelDecision {
  level: ReasoningLevel;
  rule_id: string;
  reasons: string[];
  policy_version: string;
  advisory: true;
}

export interface ReasoningLevelPolicyRule {
  id: string;
  level: ReasoningLevel;
}

export interface ReasoningLevelPolicyThresholds {
  low_confidence: number;
  fast_confidence: number;
}

export interface ReasoningLevelPolicy {
  version: string;
  thresholds: ReasoningLevelPolicyThresholds;
  fast_shapes: Array<'direct_reply' | 'task_session'>;
  cache_ttl_hours?: number;
  rules: ReasoningLevelPolicyRule[];
  shadow_model_map?: Partial<Record<ReasoningLevel, string>>;
}

let validateFn: ValidateFunction | null = null;
let cachedPolicy: ReasoningLevelPolicy | null = null;
let cachedPolicyPath: string | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function errorsFrom(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

export function validateReasoningLevelPolicy(value: unknown, label = POLICY_PATH): ReasoningLevelPolicy {
  const validate = ensureValidator();
  if (!validate(value)) {
    throw new Error(`Invalid reasoning level policy at ${label}: ${errorsFrom(validate).join('; ')}`);
  }
  return value as ReasoningLevelPolicy;
}

function loadPolicyFile(): ReasoningLevelPolicy | null {
  if (!safeExistsSync(POLICY_PATH)) return null;
  const parsed = JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string);
  return validateReasoningLevelPolicy(parsed, POLICY_PATH);
}

export function loadReasoningLevelPolicy(): ReasoningLevelPolicy {
  if (cachedPolicy && cachedPolicyPath === POLICY_PATH) return cachedPolicy;
  cachedPolicy = loadPolicyFile();
  if (!cachedPolicy) {
    throw new Error(`Reasoning level policy missing at ${POLICY_PATH}`);
  }
  cachedPolicyPath = POLICY_PATH;
  return cachedPolicy;
}

function getSelectedIntent(input: {
  selectedIntent?: StandardIntentDefinition;
}): StandardIntentDefinition | undefined {
  return input.selectedIntent;
}

function getSelectedShape(intent?: StandardIntentDefinition): 'direct_reply' | 'task_session' | undefined {
  const shape = intent?.resolution?.shape || intent?.execution_shape;
  return shape === 'direct_reply' || shape === 'task_session' ? shape : undefined;
}

function getSelectedRisk(intent?: StandardIntentDefinition): string | undefined {
  return intent?.risk_profile;
}

function buildDecision(
  level: ReasoningLevel,
  rule_id: string,
  reasons: string[],
  policy: ReasoningLevelPolicy,
): ReasoningLevelDecision {
  return {
    level,
    rule_id,
    reasons,
    policy_version: policy.version,
    advisory: true,
  };
}

export function resolveReasoningLevelDecision(
  input: {
    isSimpleGreeting: boolean;
    resolutionPacket: IntentResolutionPacket;
    selectedIntent?: StandardIntentDefinition;
  },
  policy: ReasoningLevelPolicy = loadReasoningLevelPolicy(),
): ReasoningLevelDecision {
  const selectedIntent = getSelectedIntent(input);
  const selectedConfidence = input.resolutionPacket.selected_confidence;
  const selectedShape = getSelectedShape(selectedIntent);
  const selectedRisk = getSelectedRisk(selectedIntent);

  for (const rule of policy.rules) {
    switch (rule.id) {
      case 'simple-greeting-reflex':
        if (input.isSimpleGreeting) {
          return buildDecision(
            'REFLEX_DETERMINISTIC',
            rule.id,
            ['simple greeting predicate matched'],
            policy,
          );
        }
        break;
      case 'high-risk-exploratory':
        if (selectedRisk === 'approval_required' || selectedRisk === 'high_stakes') {
          return buildDecision(
            'COGNITIVE_EXPLORATORY',
            rule.id,
            [`selected intent risk_profile=${selectedRisk}`],
            policy,
          );
        }
        break;
      case 'ambiguous-exploratory':
        if (!selectedIntent) {
          return buildDecision(
            'COGNITIVE_EXPLORATORY',
            rule.id,
            ['no selected intent'],
            policy,
          );
        }
        if (
          typeof selectedConfidence !== 'number' ||
          selectedConfidence < policy.thresholds.low_confidence
        ) {
          return buildDecision(
            'COGNITIVE_EXPLORATORY',
            rule.id,
            [
              `selected confidence ${typeof selectedConfidence === 'number' ? selectedConfidence : 'n/a'} < ${policy.thresholds.low_confidence}`,
            ],
            policy,
          );
        }
        break;
      case 'known-low-risk-fast':
        if (
          typeof selectedConfidence === 'number' &&
          selectedConfidence >= policy.thresholds.fast_confidence &&
          selectedRisk === 'low' &&
          selectedShape !== undefined &&
          policy.fast_shapes.includes(selectedShape)
        ) {
          return buildDecision(
            'REACTION_FAST',
            rule.id,
            [
              `selected confidence ${selectedConfidence} >= ${policy.thresholds.fast_confidence}`,
              `selected risk_profile=${selectedRisk}`,
              `selected shape=${selectedShape}`,
            ],
            policy,
          );
        }
        break;
      case 'default-standard':
        return buildDecision(
          'COGNITIVE_STANDARD',
          rule.id,
          ['no higher-priority rule matched'],
          policy,
        );
    }
  }

  return buildDecision(
    'COGNITIVE_STANDARD',
    'default-standard',
    ['policy did not contain a matching rule; defaulted to standard reasoning'],
    policy,
  );
}

export function resetReasoningLevelPolicyCache(): void {
  cachedPolicy = null;
  cachedPolicyPath = null;
}
