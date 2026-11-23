import * as path from 'node:path';
import { findMissionPath } from '@agent/core/path-resolver';
import {
  evaluateGateAiAssessmentPolicy,
  GATE_AI_ASSESSMENT_FILE,
  GATE_DECISION_RECORD_FILE,
  loadGateAiAssessment,
  loadGateDecisionRecord,
  logAssessmentCheckResult,
  sha256FileDigest,
  verifyGateAiAssessmentFreshness,
  verifyGateDecisionBinding,
  type GateAiAssessmentPolicy,
} from '@agent/core/mission/gate-ai-assessment';
import { loadMissionStateAtPath } from '@agent/core/mission/mission-state-reader';

export const GATE_AI_ASSESSMENT_STAGES = ['assessment', 'decision'] as const;
export type GateAiAssessmentStage = (typeof GATE_AI_ASSESSMENT_STAGES)[number];

export interface GateAiAssessmentMission {
  id: string;
  dir: string;
}

function requireCondition(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

export function resolveGateReviewMission(idInput: string): GateAiAssessmentMission {
  const id = idInput.trim().toUpperCase();
  const dir = findMissionPath(id);
  requireCondition(dir, 'Gate review mission was not found.');
  const state = loadMissionStateAtPath(path.join(dir, 'mission-state.json'));
  requireCondition(
    state && state.mission_id.toUpperCase() === id,
    'Canonical mission state is missing or invalid.'
  );
  return { id, dir };
}

function policyFromOptions(options: {
  minConfidence?: number;
  maxUnmet?: number;
  allowMissingRequired?: boolean;
  allowStale?: boolean;
}): GateAiAssessmentPolicy {
  return {
    ...(options.minConfidence !== undefined ? { min_confidence: options.minConfidence } : {}),
    ...(options.maxUnmet !== undefined ? { max_unmet: options.maxUnmet } : {}),
    ...(options.allowMissingRequired ? { block_missing_required: false } : {}),
    ...(options.allowStale ? { require_fresh_evidence: false } : {}),
  };
}

/**
 * Stage `assessment` — convening entry criteria: the AI evaluation exists, is
 * schema-valid, self-consistent, clears the confidence/unmet/missing policy,
 * and is still bound to unchanged evidence.
 */
export function checkGateAiAssessment(
  mission: GateAiAssessmentMission,
  options: Parameters<typeof policyFromOptions>[0] & { assessmentPath?: string } = {}
): { stage: 'assessment'; passed: true } {
  const loaded = loadGateAiAssessment(mission.dir, options.assessmentPath);
  requireCondition(
    loaded.assessment && loaded.path,
    loaded.error ?? 'gate AI assessment could not be loaded'
  );
  const policy = policyFromOptions(options);
  const policyResult = evaluateGateAiAssessmentPolicy(loaded.assessment, policy);
  logAssessmentCheckResult('assessment', policyResult);
  const freshnessResult =
    policy.require_fresh_evidence === false
      ? { passed: true, reasons: [] as string[] }
      : verifyGateAiAssessmentFreshness(loaded.assessment, mission.dir);
  logAssessmentCheckResult('assessment-freshness', freshnessResult);
  const reasons = [...policyResult.reasons, ...freshnessResult.reasons];
  requireCondition(
    reasons.length === 0,
    `gate AI assessment does not clear the convening policy:\n - ${reasons.join('\n - ')}\nnext: fix the evidence/assessment, or record a human override on the gate`
  );
  return { stage: 'assessment', passed: true };
}

/**
 * Stage `decision` — the human verdict must be bound to the exact assessment
 * the review body saw (ai_assessment_sha256), like the video playback approval
 * carrying the eval report digest.
 */
export function checkGateDecisionRecord(
  mission: GateAiAssessmentMission,
  options: { assessmentPath?: string; decisionPath?: string } = {}
): { stage: 'decision'; passed: true } {
  const assessment = loadGateAiAssessment(mission.dir, options.assessmentPath);
  requireCondition(
    assessment.assessment && assessment.path,
    assessment.error ?? 'gate AI assessment could not be loaded'
  );
  const record = loadGateDecisionRecord(mission.dir, options.decisionPath);
  requireCondition(
    record.record && record.path,
    record.error ?? 'gate decision record could not be loaded'
  );
  // Normalize the expected ref to the mission-relative path actually loaded,
  // so `--assessment gate-ai-assessment.json` and
  // `--assessment evidence/gate-ai-assessment.json` bind identically.
  const assessmentRef = path.relative(mission.dir, assessment.path).split(path.sep).join('/');
  const binding = verifyGateDecisionBinding({
    record: record.record,
    assessmentFileDigest: sha256FileDigest(assessment.path),
    assessmentRef,
  });
  logAssessmentCheckResult('decision', binding);
  requireCondition(
    binding.passed,
    `gate decision record is not bound to the current AI assessment:\n - ${binding.reasons.join('\n - ')}\nnext: re-run the assessment or re-record the decision against the current assessment`
  );
  return { stage: 'decision', passed: true };
}

export interface GateAiAssessmentCheckOptions {
  assessmentPath?: string;
  decisionPath?: string;
  minConfidence?: number;
  maxUnmet?: number;
  allowMissingRequired?: boolean;
  allowStale?: boolean;
}

export function checkGateAiAssessmentStage(
  mission: GateAiAssessmentMission,
  stage: GateAiAssessmentStage,
  options: GateAiAssessmentCheckOptions = {}
): { stage: GateAiAssessmentStage; passed: true } {
  if (stage === 'decision') return checkGateDecisionRecord(mission, options);
  return checkGateAiAssessment(mission, options);
}

export { GATE_AI_ASSESSMENT_FILE, GATE_DECISION_RECORD_FILE };
