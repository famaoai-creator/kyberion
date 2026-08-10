import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import {
  normalizeExecutionShape,
  projectExecutionShapeToWorkflowShape,
  type ExecutionShape,
} from './execution-shape.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const POLICY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/work-scope-policy.schema.json');
const POLICY_PATH = pathResolver.knowledge('product/governance/work-scope-policy.json');

export interface WorkScopeDecisionInput {
  catalogMinimumShape: ExecutionShape;
  artifactEstimate?: number;
  externalAudience?: boolean;
  regulatoryAudience?: boolean;
  replayOrVariantLikelihood?: boolean;
  repetitionEstimate?: number;
  multipleLegitimateViewpoints?: boolean;
  stakeholderCount?: number;
  approvalRequired?: boolean;
  crossSystemMutation?: boolean;
  expectedContinuationBeyondSession?: boolean;
  highStakesAction?: boolean;
  highStakesOrDogfoodEvidence?: boolean;
  customerSignoff?: boolean;
  productionRelease?: boolean;
  missionHandoff?: boolean;
  securitySensitiveCrossSystemChange?: boolean;
}

export interface WorkScopeSignalOptions {
  externalAudience?: boolean;
  expectedContinuationBeyondSession?: boolean;
  crossSystemMutation?: boolean;
  replayOrVariantLikelihood?: boolean;
  highStakesAction?: boolean;
}

function readBooleanSignal(
  source: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    if (typeof source[key] === 'boolean') return source[key] as boolean;
  }
  return undefined;
}

/**
 * Read only explicit, already-known work-scope facts from runtime context.
 * Heuristic inference from free text belongs to intent resolution, not here.
 */
export function resolveWorkScopeSignalOptions(
  runtimeContext?: Record<string, unknown>
): WorkScopeSignalOptions {
  const root = runtimeContext || {};
  const nested =
    root.work_scope_signals && typeof root.work_scope_signals === 'object'
      ? (root.work_scope_signals as Record<string, unknown>)
      : {};
  const source = { ...root, ...nested };
  return {
    externalAudience: readBooleanSignal(source, 'externalAudience', 'external_audience'),
    expectedContinuationBeyondSession: readBooleanSignal(
      source,
      'expectedContinuationBeyondSession',
      'expected_continuation_beyond_session'
    ),
    crossSystemMutation: readBooleanSignal(source, 'crossSystemMutation', 'cross_system_mutation'),
    replayOrVariantLikelihood: readBooleanSignal(
      source,
      'replayOrVariantLikelihood',
      'replay_or_variant_likelihood'
    ),
    highStakesAction: readBooleanSignal(source, 'highStakesAction', 'high_stakes_action'),
  };
}

export interface WorkScopeDecision {
  execution_shape: ExecutionShape;
  minimum_catalog_shape: ExecutionShape;
  promotion_required: boolean;
  mandatory_triggers: string[];
  accumulation_triggers: string[];
  matched_rule_ids: string[];
  policy_version: string;
  rationale: string;
}

export interface WorkScopeRule {
  id: string;
  when?: {
    minimum_catalog_shapes?: ExecutionShape[];
    mandatory_trigger_present?: boolean;
    accumulation_trigger_count_at_least?: number;
  };
  promotion_required: boolean;
  result_shape?: ExecutionShape;
  rationale: string;
}

export interface WorkScopePolicy {
  version: string;
  defaults: {
    accumulation_trigger_threshold: number;
  };
  mandatory_triggers: string[];
  accumulation_triggers: string[];
  rules: WorkScopeRule[];
}

let policyValidateFn: ValidateFunction | null = null;

function ensurePolicyValidator(): ValidateFunction {
  if (policyValidateFn) return policyValidateFn;
  policyValidateFn = compileSchemaFromPath(ajv, POLICY_SCHEMA_PATH);
  return policyValidateFn;
}

export function loadWorkScopePolicy(): WorkScopePolicy {
  const value = JSON.parse(
    safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string
  ) as WorkScopePolicy;
  const validate = ensurePolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid work-scope-policy: ${errors}`);
  }
  return value;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

type MandatoryTriggerEmitter = (input: WorkScopeDecisionInput) => boolean;

/**
 * The checker must inspect the same emitters used by the decision layer.
 * Keeping the policy ids and their predicates together prevents a second,
 * stale list from claiming that a trigger is reachable.
 */
export const MANDATORY_TRIGGER_EMITTERS: Record<string, MandatoryTriggerEmitter> = {
  external_regulatory_evidence: (input) =>
    normalizeBoolean(input.externalAudience) || normalizeBoolean(input.regulatoryAudience),
  high_stakes_action: (input) => normalizeBoolean(input.highStakesAction),
  high_stakes_or_dogfood_evidence: (input) => normalizeBoolean(input.highStakesOrDogfoodEvidence),
  customer_signoff: (input) => normalizeBoolean(input.customerSignoff),
  production_release: (input) => normalizeBoolean(input.productionRelease),
  mission_handoff: (input) => normalizeBoolean(input.missionHandoff),
  security_sensitive_cross_system_change: (input) =>
    normalizeBoolean(input.securitySensitiveCrossSystemChange) ||
    (normalizeBoolean(input.crossSystemMutation) &&
      normalizeBoolean(input.highStakesOrDogfoodEvidence)),
};

export const DERIVABLE_MANDATORY_TRIGGER_IDS = Object.keys(MANDATORY_TRIGGER_EMITTERS);

function deriveMandatoryTriggers(input: WorkScopeDecisionInput, policy: WorkScopePolicy): string[] {
  const triggers = Object.entries(MANDATORY_TRIGGER_EMITTERS)
    .filter(([, emitter]) => emitter(input))
    .map(([trigger]) => trigger);
  return Array.from(
    new Set(triggers.filter((trigger) => policy.mandatory_triggers.includes(trigger)))
  );
}

function deriveAccumulationTriggers(
  input: WorkScopeDecisionInput,
  policy: WorkScopePolicy
): string[] {
  const triggers: string[] = [];
  if (normalizeCount(input.artifactEstimate) >= 5) triggers.push('artifact_estimate_5plus');
  if (normalizeBoolean(input.replayOrVariantLikelihood))
    triggers.push('replay_or_variant_likelihood');
  if (normalizeCount(input.repetitionEstimate) >= 5) triggers.push('repetition_5plus');
  if (normalizeBoolean(input.multipleLegitimateViewpoints))
    triggers.push('multiple_legitimate_viewpoints');
  if (normalizeCount(input.stakeholderCount) >= 3) triggers.push('stakeholder_count_3plus');
  if (normalizeBoolean(input.approvalRequired)) triggers.push('approval_required');
  if (normalizeBoolean(input.crossSystemMutation)) triggers.push('cross_system_mutation');
  if (normalizeBoolean(input.expectedContinuationBeyondSession))
    triggers.push('expected_continuation_beyond_session');
  return Array.from(
    new Set(triggers.filter((trigger) => policy.accumulation_triggers.includes(trigger)))
  );
}

function shouldPromoteToMission(input: {
  minimumCatalogShape: ExecutionShape;
  mandatoryTriggers: string[];
  accumulationTriggers: string[];
  policy: WorkScopePolicy;
}): boolean {
  if (
    input.minimumCatalogShape === 'mission' ||
    input.minimumCatalogShape === 'project_bootstrap'
  ) {
    return true;
  }
  if (input.mandatoryTriggers.length > 0) return true;
  return input.accumulationTriggers.length >= input.policy.defaults.accumulation_trigger_threshold;
}

function pickRuleIds(input: {
  minimumCatalogShape: ExecutionShape;
  mandatoryTriggers: string[];
  accumulationTriggers: string[];
  policy: WorkScopePolicy;
  promotionRequired: boolean;
}): { matched_rule_ids: string[]; rationale: string } {
  const matchedRuleIds: string[] = [];
  const matchedRule = input.policy.rules.find((rule) => {
    const minimumCatalogShapes = rule.when?.minimum_catalog_shapes || [];
    const mandatoryTriggerPresent = rule.when?.mandatory_trigger_present;
    const accumulationTriggerCountAtLeast = rule.when?.accumulation_trigger_count_at_least;
    const minimumCatalogShapeMatches =
      minimumCatalogShapes.length === 0 || minimumCatalogShapes.includes(input.minimumCatalogShape);
    const mandatoryMatches =
      typeof mandatoryTriggerPresent !== 'boolean' ||
      mandatoryTriggerPresent === input.mandatoryTriggers.length > 0;
    const accumulationMatches =
      typeof accumulationTriggerCountAtLeast !== 'number' ||
      input.accumulationTriggers.length >= accumulationTriggerCountAtLeast;
    return minimumCatalogShapeMatches && mandatoryMatches && accumulationMatches;
  });

  if (
    input.minimumCatalogShape === 'mission' ||
    input.minimumCatalogShape === 'project_bootstrap'
  ) {
    matchedRuleIds.push('catalog-floor');
  }
  if (input.mandatoryTriggers.length > 0) {
    matchedRuleIds.push('mandatory-trigger-promotion');
  }
  if (input.accumulationTriggers.length >= input.policy.defaults.accumulation_trigger_threshold) {
    matchedRuleIds.push('accumulation-trigger-promotion');
  }
  if (!input.promotionRequired) {
    matchedRuleIds.push('catalog-floor-pass-through');
  }
  if (matchedRule?.id && !matchedRuleIds.includes(matchedRule.id)) {
    matchedRuleIds.unshift(matchedRule.id);
  }
  return {
    matched_rule_ids: Array.from(new Set(matchedRuleIds)),
    rationale:
      matchedRule?.rationale ||
      (input.promotionRequired
        ? 'Mission promotion is required because the policy trigger threshold was met.'
        : 'The catalog minimum execution shape is preserved because no mission trigger was met.'),
  };
}

export function resolveWorkScopeDecision(
  input: WorkScopeDecisionInput,
  policy: WorkScopePolicy = loadWorkScopePolicy()
): WorkScopeDecision {
  const minimumCatalogShape = normalizeExecutionShape(input.catalogMinimumShape);
  const mandatoryTriggers = deriveMandatoryTriggers(input, policy);
  const accumulationTriggers = deriveAccumulationTriggers(input, policy);
  const promotionRequired = shouldPromoteToMission({
    minimumCatalogShape,
    mandatoryTriggers,
    accumulationTriggers,
    policy,
  });
  const executionShape = promotionRequired
    ? projectExecutionShapeToWorkflowShape(
        minimumCatalogShape === 'project_bootstrap' ? 'project_bootstrap' : 'mission'
      )
    : minimumCatalogShape;
  const ruleSelection = pickRuleIds({
    minimumCatalogShape,
    mandatoryTriggers,
    accumulationTriggers,
    policy,
    promotionRequired,
  });

  return {
    execution_shape: executionShape,
    minimum_catalog_shape: minimumCatalogShape,
    promotion_required: promotionRequired,
    mandatory_triggers: mandatoryTriggers,
    accumulation_triggers: accumulationTriggers,
    matched_rule_ids: ruleSelection.matched_rule_ids,
    policy_version: policy.version,
    rationale: ruleSelection.rationale,
  };
}
