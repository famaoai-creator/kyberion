import { defineCatalog } from '../foundation/governed-catalog.js';
import { resolveIntentResolutionPacket } from '../intent/intent-resolution.js';
import { normalizeExecutionShape } from '../execution-shape.js';
import { pathResolver } from '../path-resolver.js';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
  type MissionClass,
} from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign } from './mission-review-gates.js';

/**
 * Deterministic evaluation of the utterance → intent → class → workflow →
 * team → review chain against a labelled corpus. The corpus is the
 * measuring stick for the improve-and-compare cycle on mission classification:
 * change policy/catalog data, re-run, compare the dimension scores.
 */

export type MissionClassEvalSplit = 'dev' | 'holdout';

export interface MissionClassEvalCase {
  case_id: string;
  split: MissionClassEvalSplit;
  utterance: string;
  expected_class: string;
  /** When set, the intent resolver must select exactly this intent. */
  expected_intent_id?: string;
  /** When set, the workflow selected for the resolved chain must be this template. */
  expected_workflow_id?: string;
  /** When set, the class → team-template mapping must yield this template. */
  expected_team_template?: string;
  /** Gates that must be required by the resolved review design. */
  required_gates?: string[];
  /** Gates that must NOT be required (a gate from the wrong domain is a defect). */
  forbidden_gates?: string[];
}

const corpusCatalog = defineCatalog<{ version: string; cases: MissionClassEvalCase[] }>({
  id: 'mission-class-eval-corpus',
  path: () => pathResolver.knowledge('product/governance/mission-class-eval-corpus.json'),
  schema: pathResolver.knowledge('product/schemas/mission-class-eval-corpus.schema.json'),
});

export function loadMissionClassEvalCorpus(): MissionClassEvalCase[] {
  return corpusCatalog.load().cases;
}

export type MissionClassEvalDimension = 'class' | 'intent' | 'workflow' | 'team' | 'gates';

export interface MissionClassEvalCaseResult {
  case_id: string;
  split: MissionClassEvalSplit;
  utterance: string;
  actual: {
    intent_id?: string;
    mission_class: string;
    workflow_id: string;
    team_template: string;
    required_gate_ids: string[];
  };
  failures: Array<{ dimension: MissionClassEvalDimension; expected: string; actual: string }>;
}

export interface MissionClassEvalReport {
  total: number;
  /** Share of cases passing each dimension, over the cases that declare it. */
  scores: Record<MissionClassEvalDimension, { passed: number; checked: number; rate: number }>;
  /** Share of cases passing every declared dimension. */
  overall_rate: number;
  by_split: Record<MissionClassEvalSplit, { total: number; overall_rate: number }>;
  /** expected → actual class counts for misclassified cases. */
  class_confusions: Record<string, number>;
  results: MissionClassEvalCaseResult[];
}

const DIMENSIONS: MissionClassEvalDimension[] = ['class', 'intent', 'workflow', 'team', 'gates'];

export function evaluateMissionClassCase(
  testCase: MissionClassEvalCase
): MissionClassEvalCaseResult {
  const packet = resolveIntentResolutionPacket(testCase.utterance);
  const executionShape = normalizeExecutionShape(
    packet.selected_resolution?.shape || 'task_session'
  );
  const classification = resolveMissionClassification({
    intentId: packet.selected_intent_id,
    taskType: packet.selected_resolution?.task_kind,
    shape: packet.selected_resolution?.shape,
    utterance: testCase.utterance,
  });
  const workflow = resolveMissionWorkflowDesign({
    missionClass: classification.mission_class,
    deliveryShape: classification.delivery_shape,
    riskProfile: classification.risk_profile,
    stage: classification.stage,
    executionShape,
    intentId: packet.selected_intent_id,
    taskType: packet.selected_resolution?.task_kind,
  });
  const review = resolveMissionReviewDesign({
    missionClass: classification.mission_class,
    deliveryShape: classification.delivery_shape,
    riskProfile: classification.risk_profile,
    workflowPattern: workflow.pattern,
    stage: classification.stage,
  });
  const teamTemplate = mapMissionClassToMissionTypeTemplate(
    classification.mission_class as MissionClass
  );

  const failures: MissionClassEvalCaseResult['failures'] = [];
  if (classification.mission_class !== testCase.expected_class) {
    failures.push({
      dimension: 'class',
      expected: testCase.expected_class,
      actual: classification.mission_class,
    });
  }
  if (testCase.expected_intent_id && packet.selected_intent_id !== testCase.expected_intent_id) {
    failures.push({
      dimension: 'intent',
      expected: testCase.expected_intent_id,
      actual: packet.selected_intent_id || '(none)',
    });
  }
  if (testCase.expected_workflow_id && workflow.workflow_id !== testCase.expected_workflow_id) {
    failures.push({
      dimension: 'workflow',
      expected: testCase.expected_workflow_id,
      actual: workflow.workflow_id,
    });
  }
  if (testCase.expected_team_template && teamTemplate !== testCase.expected_team_template) {
    failures.push({
      dimension: 'team',
      expected: testCase.expected_team_template,
      actual: teamTemplate,
    });
  }
  const required = new Set(review.required_gate_ids);
  const missing = (testCase.required_gates || []).filter((gate) => !required.has(gate));
  const forbidden = (testCase.forbidden_gates || []).filter((gate) => required.has(gate));
  if (missing.length || forbidden.length) {
    failures.push({
      dimension: 'gates',
      expected: [
        ...(testCase.required_gates || []),
        ...(testCase.forbidden_gates || []).map((gate) => `!${gate}`),
      ].join(','),
      actual: [
        ...missing.map((gate) => `missing:${gate}`),
        ...forbidden.map((gate) => `unwanted:${gate}`),
      ].join(','),
    });
  }

  return {
    case_id: testCase.case_id,
    split: testCase.split,
    utterance: testCase.utterance,
    actual: {
      intent_id: packet.selected_intent_id,
      mission_class: classification.mission_class,
      workflow_id: workflow.workflow_id,
      team_template: teamTemplate,
      required_gate_ids: review.required_gate_ids,
    },
    failures,
  };
}

function declaredDimensions(testCase: MissionClassEvalCase): Set<MissionClassEvalDimension> {
  const declared = new Set<MissionClassEvalDimension>(['class']);
  if (testCase.expected_intent_id) declared.add('intent');
  if (testCase.expected_workflow_id) declared.add('workflow');
  if (testCase.expected_team_template) declared.add('team');
  if (testCase.required_gates?.length || testCase.forbidden_gates?.length) declared.add('gates');
  return declared;
}

export function evaluateMissionClassCorpus(cases: MissionClassEvalCase[]): MissionClassEvalReport {
  const results = cases.map(evaluateMissionClassCase);
  const scores = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, { passed: 0, checked: 0, rate: 1 }])
  ) as MissionClassEvalReport['scores'];
  const splitTotals: Record<MissionClassEvalSplit, { total: number; passed: number }> = {
    dev: { total: 0, passed: 0 },
    holdout: { total: 0, passed: 0 },
  };
  const confusions: Record<string, number> = {};

  cases.forEach((testCase, index) => {
    const result = results[index];
    const failedDimensions = new Set(result.failures.map((failure) => failure.dimension));
    for (const dimension of declaredDimensions(testCase)) {
      scores[dimension].checked += 1;
      if (!failedDimensions.has(dimension)) scores[dimension].passed += 1;
    }
    splitTotals[testCase.split].total += 1;
    if (result.failures.length === 0) splitTotals[testCase.split].passed += 1;
    if (failedDimensions.has('class')) {
      const key = `${testCase.expected_class} -> ${result.actual.mission_class}`;
      confusions[key] = (confusions[key] || 0) + 1;
    }
  });
  for (const dimension of DIMENSIONS) {
    const score = scores[dimension];
    score.rate = score.checked === 0 ? 1 : score.passed / score.checked;
  }
  const passedAll = results.filter((result) => result.failures.length === 0).length;
  const rate = (part: { total: number; passed: number }) =>
    part.total === 0 ? 1 : part.passed / part.total;
  return {
    total: cases.length,
    scores,
    overall_rate: cases.length === 0 ? 1 : passedAll / cases.length,
    by_split: {
      dev: { total: splitTotals.dev.total, overall_rate: rate(splitTotals.dev) },
      holdout: { total: splitTotals.holdout.total, overall_rate: rate(splitTotals.holdout) },
    },
    class_confusions: confusions,
    results,
  };
}

export function formatMissionClassEvalReport(report: MissionClassEvalReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `cases=${report.total} overall=${pct(report.overall_rate)} dev=${pct(report.by_split.dev.overall_rate)} holdout=${pct(report.by_split.holdout.overall_rate)}`,
    ...DIMENSIONS.map(
      (dimension) =>
        `  ${dimension.padEnd(8)} ${report.scores[dimension].passed}/${report.scores[dimension].checked} (${pct(report.scores[dimension].rate)})`
    ),
  ];
  const confusions = Object.entries(report.class_confusions).sort((a, b) => b[1] - a[1]);
  if (confusions.length) {
    lines.push('class confusions:', ...confusions.map(([key, count]) => `  ${count}× ${key}`));
  }
  const misses = report.results.filter((result) => result.failures.length > 0);
  if (misses.length) {
    lines.push(
      'misses:',
      ...misses.map(
        (miss) =>
          `  [${miss.split}] ${miss.case_id}: ${miss.failures
            .map(
              (failure) =>
                `${failure.dimension} expected=${failure.expected} actual=${failure.actual}`
            )
            .join('; ')}`
      )
    );
  }
  return lines.join('\n');
}
