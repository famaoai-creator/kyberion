import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';
import type { ContextualIntentFrame } from './contextual-intent-frame.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/contextual-intent-clarification-policy.schema.json'
);
const POLICY_PATH = pathResolver.knowledge(
  'product/governance/contextual-intent-clarification-policy.json'
);

export type ContextualClarificationExecutionShape =
  | 'direct_reply'
  | 'task_session'
  | 'pipeline'
  | 'mission'
  | 'project_bootstrap';

export interface ContextualIntentClarificationPolicyRule {
  id?: string;
  intent_id: string;
  shapes?: ContextualClarificationExecutionShape[];
  max_missing_inputs_without_clarification?: number;
  min_confidence_to_skip?: number;
  always_ask_for?: string[];
  force_clarification_patterns?: Array<TextMatchRule | string>;
  never_ask_for?: string[];
  rationale?: string;
}

export interface ContextualIntentClarificationPolicyFile {
  version: string;
  defaults: {
    max_missing_inputs_without_clarification: number;
    min_confidence_to_skip: number;
    always_ask_for: string[];
  };
  intent_rules: ContextualIntentClarificationPolicyRule[];
}

export interface ContextualClarificationDecision {
  shouldClarify: boolean;
  reason: string;
  matchedRule?: ContextualIntentClarificationPolicyRule;
  missingInputs: string[];
}

export interface ContextualClarificationInput {
  intentId?: string;
  text?: string;
  executionShape?: ContextualClarificationExecutionShape;
  requiredInputs: string[];
  confidence?: number;
  contextualFrame?: ContextualIntentFrame;
}

let policyValidateFn: ValidateFunction | null = null;

function ensurePolicyValidator(): ValidateFunction {
  if (policyValidateFn) return policyValidateFn;
  policyValidateFn = compileSchemaFromPath(ajv, POLICY_SCHEMA_PATH);
  return policyValidateFn;
}

function loadPolicyFile(): ContextualIntentClarificationPolicyFile {
  const value = JSON.parse(safeReadFile(POLICY_PATH, { encoding: 'utf8' }) as string) as ContextualIntentClarificationPolicyFile;
  const validate = ensurePolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid contextual-intent-clarification-policy: ${errors}`);
  }
  return value;
}

function toSet(values: string[] | undefined): Set<string> {
  return new Set((values || []).map((value) => value.trim()).filter(Boolean));
}

function matchesRule(
  input: ContextualClarificationInput,
  rule: ContextualIntentClarificationPolicyRule
): boolean {
  const intentMatch = !rule.intent_id || rule.intent_id === input.intentId;
  const shapeMatch = !rule.shapes?.length || (input.executionShape ? rule.shapes.includes(input.executionShape) : false);
  return intentMatch && shapeMatch;
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function assessContextualClarification(
  input: ContextualClarificationInput
): ContextualClarificationDecision {
  const policy = loadPolicyFile();
  const missingInputs = Array.from(new Set(input.requiredInputs.map((value) => value.trim()).filter(Boolean)));
  const matchedRule = policy.intent_rules.find((rule) => matchesRule(input, rule));
  const maxMissing =
    matchedRule?.max_missing_inputs_without_clarification ??
    policy.defaults.max_missing_inputs_without_clarification;
  const minConfidence = matchedRule?.min_confidence_to_skip ?? policy.defaults.min_confidence_to_skip;
  const alwaysAskFor = toSet([
    ...policy.defaults.always_ask_for,
    ...(matchedRule?.always_ask_for || []),
  ]);
  const neverAskFor = toSet(matchedRule?.never_ask_for);
  const forceClarification =
    Boolean(input.text && matchedRule?.force_clarification_patterns?.length) &&
    matchesAnyTextRule(input.text || '', matchedRule?.force_clarification_patterns);
  if (forceClarification) {
    return {
      shouldClarify: true,
      reason: matchedRule?.rationale || 'The request matches a force-clarification ambiguity pattern.',
      matchedRule,
      missingInputs,
    };
  }

  if (missingInputs.length === 0) {
    return {
      shouldClarify: false,
      reason: 'No clarification is required because no inputs are missing.',
      missingInputs,
    };
  }

  const confidence = clampConfidence(input.confidence, 0.5);

  const criticalMissing = missingInputs.filter((item) => alwaysAskFor.has(item));
  if (criticalMissing.length > 0) {
    return {
      shouldClarify: true,
      reason: matchedRule?.rationale || `Missing critical inputs: ${criticalMissing.join(', ')}.`,
      matchedRule,
      missingInputs,
    };
  }

  const clarifiableMissing = missingInputs.filter((item) => !neverAskFor.has(item));
  if (clarifiableMissing.length === 0) {
    return {
      shouldClarify: false,
      reason: matchedRule?.rationale || 'The missing inputs are covered by policy defaults.',
      matchedRule,
      missingInputs,
    };
  }

  if (clarifiableMissing.length <= maxMissing && confidence >= minConfidence) {
    return {
      shouldClarify: false,
      reason:
        matchedRule?.rationale ||
        `The request can proceed with policy defaults because confidence is ${confidence.toFixed(2)}.`,
      matchedRule,
      missingInputs,
    };
  }

  return {
    shouldClarify: true,
    reason:
      matchedRule?.rationale ||
      `Missing inputs remain above the clarification threshold (${clarifiableMissing.length} > ${maxMissing}).`,
    matchedRule,
    missingInputs,
  };
}
