import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import type { MissionClass, MissionDeliveryShape, MissionRiskProfile, MissionStage } from './mission-classification.js';
import type { ArtifactBundle } from './artifact-bundle.js';
import { checkArtifactBundleFulfillment } from './artifact-bundle.js';

export type MissionReviewMode = 'lean' | 'standard' | 'strict';
export type ReviewGateVerdict = 'ready' | 'concerns' | 'blocked';

export interface MissionReviewDesign {
  review_mode: MissionReviewMode;
  required_gate_ids: string[];
  all_gate_ids: string[];
  rationale: string;
}

export interface ReviewGateResult {
  gate_id: string;
  verdict: ReviewGateVerdict;
  reason?: string;
}

export interface ReviewGateSummary {
  review_mode: MissionReviewMode;
  overall_verdict: ReviewGateVerdict;
  gate_results: ReviewGateResult[];
}

export interface MissionReviewSelectionInput {
  missionClass: MissionClass;
  deliveryShape: MissionDeliveryShape;
  riskProfile: MissionRiskProfile;
  workflowPattern: string;
  stage: MissionStage;
}

type RuleMatch = {
  mission_classes?: string[];
  delivery_shapes?: string[];
  risk_profiles?: string[];
  workflow_patterns?: string[];
  stages?: string[];
};

type GateRecord = {
  gate_id: string;
  description: string;
  required_in_modes: MissionReviewMode[];
  applies_to?: RuleMatch;
};

type ModeRule = {
  id: string;
  review_mode: MissionReviewMode;
  match?: RuleMatch;
};

type ReviewGateRegistry = {
  version: string;
  defaults: {
    review_mode: MissionReviewMode;
  };
  gates: GateRecord[];
  mode_rules: ModeRule[];
};

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-review-gate-registry.schema.json');
const REGISTRY_PATH = pathResolver.knowledge('product/governance/mission-review-gate-registry.json');
const RESULT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/review-gate-result.schema.json');

let registryValidateFn: ValidateFunction | null = null;
let resultValidateFn: ValidateFunction | null = null;

function ensureRegistryValidator(): ValidateFunction {
  if (registryValidateFn) return registryValidateFn;
  registryValidateFn = compileSchemaFromPath(ajv, REGISTRY_SCHEMA_PATH);
  return registryValidateFn;
}

function ensureResultValidator(): ValidateFunction {
  if (resultValidateFn) return resultValidateFn;
  resultValidateFn = compileSchemaFromPath(ajv, RESULT_SCHEMA_PATH);
  return resultValidateFn;
}

function normalizeArray(values?: string[]): string[] {
  return (values || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function matchesValue(actual: string, expected?: string[]): boolean {
  const normalized = normalizeArray(expected);
  if (!normalized.length) return true;
  return normalized.includes(actual.toLowerCase());
}

function matchRule(input: {
  missionClass: string;
  deliveryShape: string;
  riskProfile: string;
  workflowPattern: string;
  stage: string;
}, match?: RuleMatch): boolean {
  if (!match) return false;
  return (
    matchesValue(input.missionClass, match.mission_classes) &&
    matchesValue(input.deliveryShape, match.delivery_shapes) &&
    matchesValue(input.riskProfile, match.risk_profiles) &&
    matchesValue(input.workflowPattern, match.workflow_patterns) &&
    matchesValue(input.stage, match.stages)
  );
}

function loadRegistry(): ReviewGateRegistry {
  const parsed = JSON.parse(safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) as string) as ReviewGateRegistry;
  const validate = ensureRegistryValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid mission-review-gate-registry: ${errors}`);
  }
  return parsed;
}

export function resolveMissionReviewDesign(input: MissionReviewSelectionInput): MissionReviewDesign {
  const registry = loadRegistry();
  const normalized = {
    missionClass: input.missionClass.toLowerCase(),
    deliveryShape: input.deliveryShape.toLowerCase(),
    riskProfile: input.riskProfile.toLowerCase(),
    workflowPattern: input.workflowPattern.toLowerCase(),
    stage: input.stage.toLowerCase(),
  };
  const modeRule = registry.mode_rules.find((rule) => matchRule(normalized, rule.match));
  const reviewMode = modeRule?.review_mode || registry.defaults.review_mode;
  const applicableGates = registry.gates.filter((gate) => {
    if (!gate.applies_to) return true;
    return matchRule(normalized, gate.applies_to);
  });

  return {
    review_mode: reviewMode,
    required_gate_ids: applicableGates.filter((gate) => gate.required_in_modes.includes(reviewMode)).map((gate) => gate.gate_id),
    all_gate_ids: applicableGates.map((gate) => gate.gate_id),
    rationale: modeRule
      ? `Review mode ${reviewMode} selected by rule ${modeRule.id}.`
      : `Review mode ${reviewMode} selected by registry default.`,
  };
}

export function summarizeReviewGateVerdicts(input: {
  reviewMode: MissionReviewMode;
  results: ReviewGateResult[];
}): ReviewGateSummary {
  const verdicts = input.results.map((result) => result.verdict);
  const overall: ReviewGateVerdict = verdicts.includes('blocked')
    ? 'blocked'
    : verdicts.includes('concerns')
      ? 'concerns'
      : 'ready';
  const summary: ReviewGateSummary = {
    review_mode: input.reviewMode,
    overall_verdict: overall,
    gate_results: input.results,
  };
  const validate = ensureResultValidator();
  if (!validate(summary)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid review gate summary: ${errors}`);
  }
  return summary;
}

/**
 * Converts a mission's ArtifactBundle into a ReviewGateResult for the ARTIFACT_BUNDLE gate.
 * Use this helper when a mission produces a bundle of artifacts that should be approved before finish.
 */
export function evaluateArtifactBundleGate(bundle: ArtifactBundle | null | undefined): ReviewGateResult {
  if (!bundle) {
    return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'concerns', reason: 'No artifact bundle registered for this mission.' };
  }
  if (bundle.status === 'assembling') {
    return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'concerns', reason: 'Bundle is still assembling — not all artifacts collected yet.' };
  }
  if (bundle.status === 'pending_review') {
    return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'concerns', reason: 'Artifact bundle is awaiting review approval.' };
  }
  if (bundle.status === 'rejected') {
    const note = bundle.approval.note ? `: ${bundle.approval.note}` : '.';
    return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'blocked', reason: `Bundle was rejected${note}` };
  }
  if (bundle.status === 'superseded') {
    return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'concerns', reason: 'Bundle has been superseded — a new bundle must be created.' };
  }
  const report = checkArtifactBundleFulfillment(bundle);
  if (!report.fulfilled) {
    return {
      gate_id: 'ARTIFACT_BUNDLE',
      verdict: 'concerns',
      reason: `Bundle approved but missing required artifact kinds: ${report.missing.join(', ')}.`,
    };
  }
  return { gate_id: 'ARTIFACT_BUNDLE', verdict: 'ready' };
}
