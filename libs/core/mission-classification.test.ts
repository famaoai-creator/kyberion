import { describe, expect, it } from 'vitest';
import {
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
} from './mission-classification.js';

describe('mission-classification', () => {
  it('classifies research-and-absorption analysis tasks', () => {
    const classification = resolveMissionClassification({
      intentId: 'cross-project-remediation',
      taskType: 'analysis',
      shape: 'task_session',
      progressSignals: ['classified', 'plan_ready'],
    });

    expect(classification.mission_class).toBe('research_and_absorption');
    expect(classification.delivery_shape).toBe('cross_system_change');
    expect(classification.risk_profile).toBe('review_required');
    expect(classification.stage).toBe('planning');
  });

  it('detects the furthest stage from progress signals and artifacts', () => {
    const classification = resolveMissionClassification({
      taskType: 'service_operation',
      artifactPaths: ['active/shared/exports/delivery-pack.json', 'active/runtime/execution-receipt.json'],
      progressSignals: ['execution_started', 'verification_passed', 'delivery_ready'],
    });

    expect(classification.stage).toBe('delivery');
    expect(classification.matched_rules.stage_rule_id).toBe('stage-delivery');
  });

  it('falls back to defaults when no rule matches', () => {
    const classification = resolveMissionClassification({
      taskType: 'unknown_task',
      progressSignals: ['unknown_signal'],
    });

    expect(classification.mission_class).toBe('code_change');
    expect(classification.delivery_shape).toBe('single_artifact');
    expect(classification.risk_profile).toBe('review_required');
    expect(classification.stage).toBe('intake');
  });

  it('maps mission class to existing mission team templates', () => {
    expect(mapMissionClassToMissionTypeTemplate('product_delivery')).toBe('product_development');
    expect(mapMissionClassToMissionTypeTemplate('operations_and_release')).toBe('operations');
    expect(mapMissionClassToMissionTypeTemplate('environment_and_recovery')).toBe('incident');
    expect(mapMissionClassToMissionTypeTemplate('research_and_absorption')).toBe('system_query');
    expect(mapMissionClassToMissionTypeTemplate('content_and_media')).toBe('development');
    expect(mapMissionClassToMissionTypeTemplate('code_change')).toBe('development');
  });
});
