import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { resolveMissionClassification } from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign } from './mission-review-gates.js';
import { resolveWorkScopeDecision } from './work-scope-decision.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

type ScenarioPack = {
  version?: string;
  scenarios?: Array<{
    scenario_id?: string;
    utterance?: string;
    classification_input?: {
      progress_signals?: string[];
      artifact_paths?: string[];
    };
    work_scope_input?: {
      catalog_minimum_shape?: string;
      artifact_estimate?: number;
      external_audience?: boolean;
      regulatory_audience?: boolean;
      replay_or_variant_likelihood?: boolean;
      repetition_estimate?: number;
      multiple_legitimate_viewpoints?: boolean;
      stakeholder_count?: number;
      approval_required?: boolean;
      cross_system_mutation?: boolean;
      expected_continuation_beyond_session?: boolean;
      high_stakes_or_dogfood_evidence?: boolean;
      customer_signoff?: boolean;
      production_release?: boolean;
      mission_handoff?: boolean;
      security_sensitive_cross_system_change?: boolean;
    };
    expected?: {
      intent_id?: string;
      execution_shape?: string;
      mission_class?: string;
      delivery_shape?: string;
      risk_profile?: string;
      stage?: string;
      workflow_id?: string;
      workflow_pattern?: string;
      review_mode?: string;
      required_gate_ids?: string[];
      promotion_required?: boolean;
    };
  }>;
};

function loadScenarioPack(): ScenarioPack {
  return JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/governance/mission-task-classification-scenarios.json'),
      { encoding: 'utf8' },
    ) as string,
  ) as ScenarioPack;
}

function readSchema() {
  const ajv = new Ajv({ allErrors: true });
  const validate = compileSchemaFromPath(
    ajv,
    pathResolver.knowledge('product/schemas/mission-task-classification-scenarios.schema.json'),
  );
  return validate;
}

function toWorkScopeDecisionInput(input: NonNullable<NonNullable<ScenarioPack['scenarios']>[number]['work_scope_input']>) {
  return {
    catalogMinimumShape: input.catalog_minimum_shape as
      | 'direct_reply'
      | 'actuator_action'
      | 'browser_session'
      | 'task_session'
      | 'pipeline'
      | 'mission'
      | 'project_bootstrap',
    artifactEstimate: input.artifact_estimate,
    externalAudience: input.external_audience,
    regulatoryAudience: input.regulatory_audience,
    replayOrVariantLikelihood: input.replay_or_variant_likelihood,
    repetitionEstimate: input.repetition_estimate,
    multipleLegitimateViewpoints: input.multiple_legitimate_viewpoints,
    stakeholderCount: input.stakeholder_count,
    approvalRequired: input.approval_required,
    crossSystemMutation: input.cross_system_mutation,
    expectedContinuationBeyondSession: input.expected_continuation_beyond_session,
    highStakesOrDogfoodEvidence: input.high_stakes_or_dogfood_evidence,
    customerSignoff: input.customer_signoff,
    productionRelease: input.production_release,
    missionHandoff: input.mission_handoff,
    securitySensitiveCrossSystemChange: input.security_sensitive_cross_system_change,
  };
}

describe('mission-task-classification scenarios', () => {
  it('validates the scenario pack schema', () => {
    const validate = readSchema();
    const pack = loadScenarioPack();

    expect(validate(pack), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('resolves representative Japanese and English user requests into the expected governance path', () => {
    const pack = loadScenarioPack();

    for (const scenario of pack.scenarios || []) {
      const utterance = scenario.utterance || '';
      const packet = resolveIntentResolutionPacket(utterance);

      expect(packet.selected_intent_id, `intent mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.intent_id,
      );
      expect(packet.selected_resolution?.shape, `shape mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.execution_shape,
      );

      const classification = resolveMissionClassification({
        intentId: packet.selected_intent_id,
        taskType: packet.selected_resolution?.task_kind,
        shape: packet.selected_resolution?.shape,
        utterance,
        progressSignals: scenario.classification_input?.progress_signals,
        artifactPaths: scenario.classification_input?.artifact_paths,
      });

      expect(classification.mission_class, `mission class mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.mission_class,
      );
      expect(classification.delivery_shape, `delivery shape mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.delivery_shape,
      );
      expect(classification.risk_profile, `risk profile mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.risk_profile,
      );
      expect(classification.stage, `stage mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.stage,
      );

      const workflow = resolveMissionWorkflowDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        stage: classification.stage,
        executionShape: packet.selected_resolution?.shape || 'task_session',
        intentId: packet.selected_intent_id,
        taskType: packet.selected_resolution?.task_kind,
      });

      expect(workflow.workflow_id, `workflow mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.workflow_id,
      );
      expect(workflow.pattern, `workflow pattern mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.workflow_pattern,
      );

      const review = resolveMissionReviewDesign({
        missionClass: classification.mission_class,
        deliveryShape: classification.delivery_shape,
        riskProfile: classification.risk_profile,
        workflowPattern: workflow.pattern,
        stage: classification.stage,
      });

      expect(review.review_mode, `review mode mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.review_mode,
      );
      expect(review.required_gate_ids, `required gates mismatch for ${scenario.scenario_id}`).toEqual(
        scenario.expected?.required_gate_ids,
      );

      const workScope = resolveWorkScopeDecision(
        toWorkScopeDecisionInput(scenario.work_scope_input || { catalog_minimum_shape: 'task_session' }),
      );

      expect(workScope.promotion_required, `promotion mismatch for ${scenario.scenario_id}`).toBe(
        scenario.expected?.promotion_required,
      );
      if (scenario.work_scope_input?.catalog_minimum_shape === 'project_bootstrap') {
        expect(workScope.execution_shape, `scope shape mismatch for ${scenario.scenario_id}`).toBe(
          'project_bootstrap',
        );
      } else if (scenario.expected?.promotion_required) {
        expect(workScope.execution_shape, `scope shape mismatch for ${scenario.scenario_id}`).toBe(
          'mission',
        );
      } else {
        expect(workScope.execution_shape, `scope shape mismatch for ${scenario.scenario_id}`).toBe(
          scenario.work_scope_input?.catalog_minimum_shape,
        );
      }
    }
  });
});
