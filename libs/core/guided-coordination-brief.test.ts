import { describe, expect, it } from 'vitest';
import {
  buildGuidedCoordinationBrief,
} from './guided-coordination-brief.js';
import { buildExecutionBriefFromGuidedCoordinationBrief } from './execution-brief.js';

describe('guided-coordination-brief', () => {
  it('builds a shared brief before narrowing into a meeting execution brief', () => {
    const guided = buildGuidedCoordinationBrief({
      requestText: '来週の役員会議の進め方を整えて',
      goalSummary: '役員会議の進行と事前資料の準備を共通化する',
      audienceOrCounterpart: '取締役会',
      approvalBoundary: 'Do not publish board materials without explicit approval.',
      serviceBindings: ['github:org:board', 'slack:org:ops'],
      tier: 'confidential',
      locale: 'ja-JP',
    });

    expect(guided.kind).toBe('guided-coordination-brief');
    expect(guided.coordination_kind).toBe('meeting');
    expect(guided.preference_profile_refs).toContain('meeting-operations-profile');
    expect(guided.service_binding_refs).toEqual(['github:org:board', 'slack:org:ops']);
    expect(guided.recommended_next_step).toContain('specialized brief');
    expect(guided.missing_inputs).toContain('meeting_url');

    const execution = buildExecutionBriefFromGuidedCoordinationBrief(guided, {
      requestText: '来週の役員会議の進め方を整えて',
      intentId: 'meeting-operations',
      tier: 'confidential',
      locale: 'ja-JP',
      goalSummary: '役員会議の進行と事前資料の準備を共通化する',
      serviceBindings: ['github:org:board', 'slack:org:ops'],
    });

    expect(execution.kind).toBe('actuator-execution-brief');
    expect(execution.summary).toBe(guided.objective);
    expect(execution.normalized_scope?.[0]).toBe('meeting');
    expect(execution.target_actuators).toEqual(guided.suggested_target_actuators);
    expect(execution.deliverables).toEqual(guided.suggested_deliverables);
    expect(execution.missing_inputs).toEqual(guided.missing_inputs);
    expect(execution.service_binding_refs).toEqual(['github:org:board', 'slack:org:ops']);
  });

  it('keeps the shared brief broad for non-specialized requests', () => {
    const guided = buildGuidedCoordinationBrief({
      requestText: 'この依頼の進め方を共通化したい',
      summaryHint: '共通プロトコルの整理',
    });

    expect(guided.coordination_kind).toBe('general');
    expect(guided.preference_profile_refs).toEqual([]);
    expect(guided.suggested_deliverables).toContain('coordination_brief');
  });
});
