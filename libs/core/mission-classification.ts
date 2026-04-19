import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

export type MissionClass =
  | 'product_delivery'
  | 'code_change'
  | 'research_and_absorption'
  | 'content_and_media'
  | 'operations_and_release'
  | 'environment_and_recovery';

export type MissionDeliveryShape =
  | 'single_artifact'
  | 'multi_artifact_pipeline'
  | 'long_running_job'
  | 'interactive_exploration'
  | 'cross_system_change';

export type MissionRiskProfile = 'low' | 'review_required' | 'approval_required' | 'high_stakes';

export type MissionStage =
  | 'intake'
  | 'classification'
  | 'planning'
  | 'contract_authoring'
  | 'preflight'
  | 'execution'
  | 'verification'
  | 'delivery'
  | 'retrospective';

export interface MissionClassificationInput {
  missionTypeHint?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
  artifactPaths?: string[];
  progressSignals?: string[];
}

export interface MissionClassification {
  mission_class: MissionClass;
  delivery_shape: MissionDeliveryShape;
  risk_profile: MissionRiskProfile;
  stage: MissionStage;
  matched_rules: {
    mission_class_rule_id?: string;
    delivery_shape_rule_id?: string;
    risk_rule_id?: string;
    stage_rule_id?: string;
  };
  evidence: {
    normalized_artifact_paths: string[];
    normalized_signals: string[];
  };
}

type RoutingMatch = {
  mission_type_hints?: string[];
  intent_ids?: string[];
  task_types?: string[];
  shapes?: string[];
  utterance_patterns?: string[];
};

type ClassificationPolicy = {
  version: string;
  defaults: {
    mission_class: MissionClass;
    delivery_shape: MissionDeliveryShape;
    risk_profile: MissionRiskProfile;
    stage: MissionStage;
  };
  stage_progression: MissionStage[];
  mission_class_rules: Array<{ id: string; match?: RoutingMatch; mission_class: MissionClass }>;
  delivery_shape_rules: Array<{ id: string; match?: RoutingMatch; delivery_shape: MissionDeliveryShape }>;
  risk_profile_rules: Array<{ id: string; match?: RoutingMatch; risk_profile: MissionRiskProfile }>;
  stage_rules: Array<{
    id: string;
    stage: MissionStage;
    when?: {
      artifacts_any?: string[];
      artifacts_all?: string[];
      signals_any?: string[];
      signals_all?: string[];
    };
  }>;
};

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/mission-classification-policy.schema.json');
const POLICY_PATH = pathResolver.knowledge('public/governance/mission-classification-policy.json');
const RESULT_SCHEMA_PATH = pathResolver.knowledge('public/schemas/mission-classification.schema.json');

let policyValidateFn: ValidateFunction | null = null;
let resultValidateFn: ValidateFunction | null = null;

function ensurePolicyValidator(): ValidateFunction {
  if (policyValidateFn) return policyValidateFn;
  policyValidateFn = compileSchemaFromPath(ajv, POLICY_SCHEMA_PATH);
  return policyValidateFn;
}

function ensureResultValidator(): ValidateFunction {
  if (resultValidateFn) return resultValidateFn;
  resultValidateFn = compileSchemaFromPath(ajv, RESULT_SCHEMA_PATH);
  return resultValidateFn;
}

function normalizePath(value: string): string {
  return value.trim().toLowerCase().replace(/\\/g, '/');
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeList(input: string[] | undefined): string[] {
  return Array.from(new Set((input || []).map(normalizeValue).filter(Boolean)));
}

function normalizePathList(input: string[] | undefined): string[] {
  return Array.from(new Set((input || []).map(normalizePath).filter(Boolean)));
}

function matchesValue(actual: string | undefined, expected: string[] | undefined): boolean {
  if (!expected?.length) return true;
  if (!actual) return false;
  if (expected.includes('*')) return true;
  return expected.includes(actual);
}

function matchesPattern(utterance: string | undefined, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return true;
  if (!utterance) return false;
  return patterns.some((pattern) => utterance.includes(pattern));
}

function ruleMatches(input: {
  missionTypeHint?: string;
  intentId?: string;
  taskType?: string;
  shape?: string;
  utterance?: string;
}, match?: RoutingMatch): boolean {
  if (!match) return false;
  return (
    matchesValue(input.missionTypeHint, match.mission_type_hints) &&
    matchesValue(input.intentId, match.intent_ids) &&
    matchesValue(input.taskType, match.task_types) &&
    matchesValue(input.shape, match.shapes) &&
    matchesPattern(input.utterance, match.utterance_patterns)
  );
}

function stageRuleMatches(input: {
  artifacts: string[];
  signals: string[];
}, rule: ClassificationPolicy['stage_rules'][number]): boolean {
  const artifacts = input.artifacts;
  const signals = input.signals;
  const signalSet = new Set(signals);
  const artifactsAny = normalizePathList(rule.when?.artifacts_any);
  const artifactsAll = normalizePathList(rule.when?.artifacts_all);
  const signalsAny = normalizeList(rule.when?.signals_any);
  const signalsAll = normalizeList(rule.when?.signals_all);

  if (artifactsAny.length && !artifactsAny.some((pattern) => artifacts.some((path) => path.includes(pattern)))) {
    return false;
  }
  if (artifactsAll.length && !artifactsAll.every((pattern) => artifacts.some((path) => path.includes(pattern)))) {
    return false;
  }
  if (signalsAny.length && !signalsAny.some((signal) => signalSet.has(signal))) {
    return false;
  }
  if (signalsAll.length && !signalsAll.every((signal) => signalSet.has(signal))) {
    return false;
  }

  if (!artifactsAny.length && !artifactsAll.length && !signalsAny.length && !signalsAll.length) {
    return false;
  }
  return true;
}

function loadPolicy(): ClassificationPolicy {
  const parsed = JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string) as ClassificationPolicy;
  const validate = ensurePolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid mission-classification-policy: ${errors}`);
  }
  return parsed;
}

function coerceInput(input: MissionClassificationInput) {
  return {
    missionTypeHint: input.missionTypeHint ? normalizeValue(input.missionTypeHint) : undefined,
    intentId: input.intentId ? normalizeValue(input.intentId) : undefined,
    taskType: input.taskType ? normalizeValue(input.taskType) : undefined,
    shape: input.shape ? normalizeValue(input.shape) : undefined,
    utterance: input.utterance ? normalizeValue(input.utterance) : undefined,
    artifacts: normalizePathList(input.artifactPaths),
    signals: normalizeList(input.progressSignals),
  };
}

export function resolveMissionClassification(input: MissionClassificationInput): MissionClassification {
  const policy = loadPolicy();
  const normalized = coerceInput(input);
  const matchInput = {
    missionTypeHint: normalized.missionTypeHint,
    intentId: normalized.intentId,
    taskType: normalized.taskType,
    shape: normalized.shape,
    utterance: normalized.utterance,
  };

  const classRule = policy.mission_class_rules.find((rule) => ruleMatches(matchInput, rule.match));
  const deliveryRule = policy.delivery_shape_rules.find((rule) => ruleMatches(matchInput, rule.match));
  const riskRule = policy.risk_profile_rules.find((rule) => ruleMatches(matchInput, rule.match));

  const stageRuleMatchesAll = policy.stage_rules.filter((rule) =>
    stageRuleMatches({ artifacts: normalized.artifacts, signals: normalized.signals }, rule),
  );
  const stageOrder = new Map(policy.stage_progression.map((stage, index) => [stage, index]));
  const stageRule = stageRuleMatchesAll.sort((left, right) => {
    const leftIndex = stageOrder.get(left.stage) ?? -1;
    const rightIndex = stageOrder.get(right.stage) ?? -1;
    return rightIndex - leftIndex;
  })[0];

  const resolved: MissionClassification = {
    mission_class: classRule?.mission_class || policy.defaults.mission_class,
    delivery_shape: deliveryRule?.delivery_shape || policy.defaults.delivery_shape,
    risk_profile: riskRule?.risk_profile || policy.defaults.risk_profile,
    stage: stageRule?.stage || policy.defaults.stage,
    matched_rules: {
      mission_class_rule_id: classRule?.id,
      delivery_shape_rule_id: deliveryRule?.id,
      risk_rule_id: riskRule?.id,
      stage_rule_id: stageRule?.id,
    },
    evidence: {
      normalized_artifact_paths: normalized.artifacts,
      normalized_signals: normalized.signals,
    },
  };

  const validate = ensureResultValidator();
  if (!validate(resolved)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid mission classification result: ${errors}`);
  }
  return resolved;
}

export function mapMissionClassToMissionTypeTemplate(missionClass: MissionClass): string {
  if (missionClass === 'product_delivery') return 'product_development';
  if (missionClass === 'operations_and_release') return 'operations';
  if (missionClass === 'environment_and_recovery') return 'incident';
  if (missionClass === 'research_and_absorption') return 'system_query';
  return 'development';
}
