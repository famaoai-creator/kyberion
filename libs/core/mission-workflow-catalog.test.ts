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
});
