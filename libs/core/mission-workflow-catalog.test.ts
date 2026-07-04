import { describe, expect, it } from 'vitest';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';

describe('mission-workflow-catalog', () => {
  it('selects stage-gated workflow for high-stakes mission shapes', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'cross_system_change',
      riskProfile: 'high_stakes',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'incident-informed-review',
      taskType: 'analysis',
    });

    expect(workflow.workflow_id).toBe('stage-gated-high-stakes');
    expect(workflow.pattern).toBe('stage_gated_delivery');
    expect(workflow.phases).toContain('preflight');
  });

  it('falls back to single-track workflow when no specific rule matches', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'code_change',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'execution',
      executionShape: 'task_session',
    });

    expect(workflow.workflow_id).toBe('single-track-default');
    expect(workflow.pattern).toBe('single_track_execution');
  });

  it('selects the AI-DLC template for code_change missions (MO-01)', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'code_change',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
    });

    expect(workflow.workflow_id).toBe('code-change-aidlc');
    expect(workflow.phases).toEqual(
      expect.arrayContaining(['alignment', 'execution', 'test', 'self_review'])
    );
  });

  it('selects distinct phase sequences per mission class (MO-01)', () => {
    const codeChange = resolveMissionWorkflowDesign({
      missionClass: 'code_change',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
    });
    const research = resolveMissionWorkflowDesign({
      missionClass: 'research_and_absorption',
      deliveryShape: 'interactive_exploration',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
    });
    const content = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'generate-presentation',
    });

    const ids = [codeChange.workflow_id, research.workflow_id, content.workflow_id];
    expect(new Set(ids).size).toBe(3);
    // The AI-DLC code-change sequence must differ from the generic sequences.
    expect(codeChange.phases.join('>')).not.toBe(research.phases.join('>'));
    expect(codeChange.phases.join('>')).not.toBe(content.phases.join('>'));
  });
});
