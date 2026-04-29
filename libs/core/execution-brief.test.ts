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
});
