import { describe, expect, it } from 'vitest';
import { buildFallbackExecutionBrief } from './execution-brief.js';

describe('execution-brief', () => {
  it('keeps meeting schedule coordination on the schedule branch and asks for the handoff boundary', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: '会議の日程を調整して',
      intentId: 'schedule-coordination',
      taskType: 'service_operation',
      serviceBindings: ['google:calendar', 'slack:ops'],
    });

    expect(brief.archetype_id).toBe('schedule-coordination');
    expect(brief.missing_inputs).toEqual([
      'schedule_scope',
      'date_range',
      'fixed_constraints',
      'calendar_action_boundary',
      'meeting_handoff_boundary',
    ]);
    expect(brief.clarification_questions?.at(-1)?.id).toBe('meeting_handoff_boundary');
    expect(brief.clarification_questions?.at(-1)?.question).toContain('meeting operations');
    expect(brief.readiness_reason).toContain('schedule coordination');
    expect(brief.service_binding_refs).toEqual(['google:calendar', 'slack:ops']);
  });

  it('keeps plain meeting requests on the meeting branch', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: 'Teamsで開催されるオンラインミーティングに私の代わりに参加して無事成功させる',
      intentId: 'meeting-operations',
      taskType: 'meeting_operations',
    });

    expect(brief.archetype_id).toBe('meeting-operations');
    expect(brief.missing_inputs).toEqual([
      'meeting_url',
      'meeting_role_boundary',
      'meeting_purpose',
    ]);
    expect(brief.clarification_questions?.[0]?.id).toBe('meeting_url');
  });

  it('populates input_bindings with typed metadata for missing inputs', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: 'Teamsで会議に参加して',
      intentId: 'meeting-operations',
    });

    const bindings = (brief as any).input_bindings as Array<{ id: string; type: string; label: string }>;
    expect(Array.isArray(bindings)).toBe(true);
    expect(bindings.length).toBe(brief.missing_inputs.length);

    const urlBinding = bindings.find((b) => b.id === 'meeting_url');
    expect(urlBinding?.type).toBe('url');
    expect(urlBinding?.label).toBeTruthy();
  });

  it('builds a staged approval workflow brief with approval system candidates', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: '稟議の決裁しておいて',
      intentId: 'resolve-approval',
      taskType: 'service_operation',
      serviceBindings: ['kintone:approval', 'slack:ops'],
    });

    expect(brief.archetype_id).toBe('resolve-approval');
    expect(brief.approval_system).toBeTruthy();
    expect(brief.workflow_steps?.map((step) => step.phase)).toEqual([
      'resolve_system',
      'authenticate',
      'list_pending',
      'review_item',
      'decide',
      'summarize',
    ]);
    expect(brief.workflow_steps?.[0]?.description).toContain('approval system');
    expect(brief.workflow_steps?.[4]?.requires_confirmation).toBe(true);
    expect(brief.readiness_reason).toContain('review pending items');
  });

  it('routes capture_photo briefs through the virtual camera bridge boundary', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: '記録用に写真を1枚撮って',
      taskType: 'capture_photo',
    });

    expect(brief.archetype_id).toBe('capture_photo-execution');
    expect(brief.target_actuators).toContain('virtual-camera-bridge');
    expect(brief.target_actuators).toContain('vision-actuator');
    expect(brief.target_actuators).toContain('artifact-actuator');
  });
});
