import { describe, expect, it } from 'vitest';
import { mapMissionClassToMissionTypeTemplate, MISSION_CLASS_VALUES } from './mission-classification.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';
import { resolveMissionReviewDesign } from './mission-review-gates.js';
import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

type WorkflowCatalogFile = {
  templates?: Array<{
    id?: string;
    match?: {
      mission_classes?: string[];
    };
  }>;
};

type ReviewRegistryFile = {
  gates?: Array<{
    gate_id?: string;
    applies_to?: {
      mission_classes?: string[];
    };
  }>;
  mode_rules?: Array<{
    id?: string;
    match?: {
      mission_classes?: string[];
    };
  }>;
};

type TeamTemplateRegistry = {
  templates?: Record<string, unknown>;
};

function readJson<T>(logicalPath: string): T {
  return JSON.parse(safeReadFile(pathResolver.knowledge(logicalPath), { encoding: 'utf8' }) as string) as T;
}

describe('mission-classification contract', () => {
  it('keeps the canonical classes aligned with workflows, review gates, and team templates', () => {
    expect(MISSION_CLASS_VALUES).toEqual([
      'product_delivery',
      'code_change',
      'research_and_absorption',
      'content_and_media',
      'operations_and_release',
      'environment_and_recovery',
      'decision_support',
      'customer_engagement',
      'platform_onboarding',
    ]);

    const workflowCatalog = readJson<WorkflowCatalogFile>('product/governance/mission-workflow-catalog.json');
    const reviewRegistry = readJson<ReviewRegistryFile>('product/governance/mission-review-gate-registry.json');
    const teamTemplates = readJson<TeamTemplateRegistry>('product/orchestration/mission-team-templates.json');

    const workflowMissionClasses = new Set(
      (workflowCatalog.templates || []).flatMap((template) => template.match?.mission_classes || []),
    );
    const reviewMissionClasses = new Set([
      ...(reviewRegistry.gates || []).flatMap((gate) => gate.applies_to?.mission_classes || []),
      ...(reviewRegistry.mode_rules || []).flatMap((rule) => rule.match?.mission_classes || []),
    ]);
    const templateIds = new Set(Object.keys(teamTemplates.templates || {}));

    for (const missionClass of MISSION_CLASS_VALUES) {
      expect(workflowMissionClasses.has(missionClass)).toBe(true);
      expect(reviewMissionClasses.has(missionClass)).toBe(true);
      expect(templateIds.has(mapMissionClassToMissionTypeTemplate(missionClass))).toBe(true);

      const workflow = resolveMissionWorkflowDesign({
        missionClass,
        deliveryShape: missionClass === 'operations_and_release' || missionClass === 'platform_onboarding'
          ? 'cross_system_change'
          : missionClass === 'decision_support' || missionClass === 'research_and_absorption'
            ? 'interactive_exploration'
            : missionClass === 'content_and_media' || missionClass === 'product_delivery' || missionClass === 'customer_engagement'
              ? 'multi_artifact_pipeline'
              : 'single_artifact',
        riskProfile:
          missionClass === 'operations_and_release' || missionClass === 'platform_onboarding'
            ? 'high_stakes'
            : missionClass === 'customer_engagement' || missionClass === 'decision_support'
              ? 'approval_required'
              : 'review_required',
        stage: 'planning',
        executionShape:
          missionClass === 'operations_and_release' ||
          missionClass === 'platform_onboarding' ||
          missionClass === 'decision_support' ||
          missionClass === 'content_and_media'
            ? 'mission'
            : 'task_session',
        intentId: missionClass,
        taskType: missionClass,
      });
      expect(workflow.workflow_id).toBeTruthy();

      const review = resolveMissionReviewDesign({
        missionClass,
        deliveryShape:
          missionClass === 'operations_and_release' || missionClass === 'platform_onboarding'
            ? 'cross_system_change'
            : missionClass === 'decision_support' || missionClass === 'research_and_absorption'
              ? 'interactive_exploration'
              : 'single_artifact',
        riskProfile:
          missionClass === 'operations_and_release' || missionClass === 'platform_onboarding'
            ? 'high_stakes'
            : missionClass === 'customer_engagement' ? 'approval_required' : 'review_required',
        workflowPattern: workflow.pattern,
        stage: 'planning',
      });
      expect(review.required_gate_ids).toBeInstanceOf(Array);
      expect(review.all_gate_ids).toBeInstanceOf(Array);
    }
  });
});
