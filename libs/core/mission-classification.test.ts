import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  MISSION_CLASS_VALUES,
  mapMissionClassToMissionTypeTemplate,
  resolveMissionClassification,
} from './mission-classification.js';
import { safeReadFile } from './secure-io.js';

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
      artifactPaths: [
        'active/shared/exports/delivery-pack.json',
        'active/runtime/execution-receipt.json',
      ],
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

  it('routes meeting facilitation mission hints into operations and release with a multi-artifact shape', () => {
    const classification = resolveMissionClassification({
      missionTypeHint: 'meeting_facilitation',
    });

    expect(classification.mission_class).toBe('operations_and_release');
    expect(classification.delivery_shape).toBe('multi_artifact_pipeline');
    expect(classification.matched_rules.mission_class_rule_id).toBe(
      'class-operations-release-meeting-facilitation'
    );
    expect(classification.matched_rules.delivery_shape_rule_id).toBe(
      'delivery-meeting-facilitation'
    );
  });

  it('routes presentation/document production hints into content_and_media (MO-01)', () => {
    const presentation = resolveMissionClassification({
      missionTypeHint: 'presentation_production',
    });
    const document = resolveMissionClassification({
      missionTypeHint: 'document_production',
    });

    expect(presentation.mission_class).toBe('content_and_media');
    expect(presentation.matched_rules.mission_class_rule_id).toBe(
      'class-content-media-presentation-hint'
    );
    expect(document.mission_class).toBe('content_and_media');
  });

  it('routes incident analysis hints and intents into operations_and_release (MO-01)', () => {
    const byHint = resolveMissionClassification({ missionTypeHint: 'incident_analysis' });
    const byIntent = resolveMissionClassification({ intentId: 'incident-analysis' });

    expect(byHint.mission_class).toBe('operations_and_release');
    expect(byIntent.mission_class).toBe('operations_and_release');
  });

  it('routes presentation utterances into content_and_media (MO-01)', () => {
    const classification = resolveMissionClassification({
      utterance: '顧客向けの提案書パワーポイントを作成したい',
    });

    expect(classification.mission_class).toBe('content_and_media');
  });

  it('routes the new business process hints onto their mission classes (MO-01)', () => {
    const expectations: Array<[string, string]> = [
      ['research_report', 'research_and_absorption'],
      ['data_analysis', 'decision_support'],
      ['marketing_campaign', 'content_and_media'],
      ['contract_review', 'decision_support'],
      ['customer_onboarding', 'customer_engagement'],
      ['training_material', 'content_and_media'],
      ['event_planning', 'operations_and_release'],
    ];
    for (const [hint, expectedClass] of expectations) {
      const classification = resolveMissionClassification({ missionTypeHint: hint });
      expect(classification.mission_class, `hint ${hint}`).toBe(expectedClass);
    }
  });

  it('routes event planning onto a multi-artifact delivery shape', () => {
    const classification = resolveMissionClassification({ missionTypeHint: 'event_planning' });
    expect(classification.delivery_shape).toBe('multi_artifact_pipeline');
  });

  it('routes business process utterances onto their mission classes (MO-01)', () => {
    expect(
      resolveMissionClassification({ utterance: '来期に向けた市場調査レポートをまとめたい' })
        .mission_class
    ).toBe('research_and_absorption');
    expect(
      resolveMissionClassification({ utterance: '新製品の研修資料を作成してほしい' }).mission_class
    ).toBe('content_and_media');
    expect(
      resolveMissionClassification({ utterance: '委託契約書の確認をお願いしたい' }).mission_class
    ).toBe('decision_support');
  });

  it('maps mission class to existing mission team templates', () => {
    expect(mapMissionClassToMissionTypeTemplate('product_delivery')).toBe('product_development');
    expect(mapMissionClassToMissionTypeTemplate('operations_and_release')).toBe('operations');
    expect(mapMissionClassToMissionTypeTemplate('environment_and_recovery')).toBe('incident');
    expect(mapMissionClassToMissionTypeTemplate('research_and_absorption')).toBe('system_query');
    expect(mapMissionClassToMissionTypeTemplate('content_and_media')).toBe('development');
    expect(mapMissionClassToMissionTypeTemplate('code_change')).toBe('development');
    expect(mapMissionClassToMissionTypeTemplate('decision_support')).toBe('development');
    expect(mapMissionClassToMissionTypeTemplate('customer_engagement')).toBe('surface_concierge');
    expect(mapMissionClassToMissionTypeTemplate('platform_onboarding')).toBe('operations');
  });

  it('keeps the runtime mission class list aligned with the schema enum', () => {
    const schemaPath = path.resolve(
      process.cwd(),
      'knowledge/product/schemas/mission-classification.schema.json'
    );
    const schema = JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string) as {
      properties?: { mission_class?: { enum?: string[] } };
    };
    const schemaClasses = schema.properties?.mission_class?.enum || [];

    expect(MISSION_CLASS_VALUES).toEqual(schemaClasses);
  });
});
