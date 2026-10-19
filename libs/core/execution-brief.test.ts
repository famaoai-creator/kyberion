import { describe, expect, it } from 'vitest';
import { buildFallbackExecutionBrief } from './execution-brief.js';
import { resolveIntentResolutionPacket } from './intent/intent-resolution.js';

describe('execution-brief', () => {
  const documentProjectRequest =
    '会議準備チェックリストの文書を作る新規プロジェクト。提出期限と担当者、遅れた場合の連絡先を含め、レビューを受けて改訂する。';

  it.each([false, true])(
    'keeps a document project out of calendar and live-meeting planning (resolved=%s)',
    (resolved) => {
      const packet = resolveIntentResolutionPacket(documentProjectRequest);
      const brief = buildFallbackExecutionBrief({
        requestText: documentProjectRequest,
        ...(resolved ? { intentId: packet.selected_intent_id } : {}),
        executionShape: 'project_bootstrap',
        tier: 'public',
        projectName: 'Checklist documents',
        serviceBindings: ['fixture:documents'],
      });
      expect(brief.archetype_id).toBe('bootstrap-project');
      expect(brief.missing_inputs).toEqual(['project_brief']);
      expect(brief.clarification_questions?.map((question) => question.id)).toEqual([
        'project_brief',
      ]);
      expect(brief.deliverables).toContain('project_created');
      expect(brief.normalized_scope).not.toContain('meeting');
      expect(brief.target_actuators).not.toContain('meeting-actuator');
      expect(brief.calendar_source).toBeUndefined();
      expect(brief.readiness).toBe('needs_clarification');
      expect(brief.service_binding_refs).toEqual(['fixture:documents']);
      expect(brief.normalized_scope).toContain('Checklist documents');
    }
  );

  it('does not bootstrap a project mentioned only as the topic of a calendar read', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: '文書を作る新規プロジェクトの来週のレビュー会議の予定を教えて',
    });
    expect(brief.archetype_id).toBe('schedule-read-agenda');
    expect(brief.deliverables).not.toContain('project_created');
    expect(brief.calendar_source).toBeTruthy();
  });

  it.each([
    ['新規プロジェクトで文書を作成する申請を承認して', 'resolve-approval'],
    ['Approve the request to start a new project to write a report.', 'resolve-approval'],
    [
      'Do not start a new project or write a report. Show my calendar for tomorrow.',
      'schedule-read-agenda',
    ],
    ['新規プロジェクトで文書を書いてはいけません。来週の会議予定を教えて', 'schedule-read-agenda'],
  ])('preserves the requested action in a non-project brief: %s', (requestText, archetype) => {
    const packet = resolveIntentResolutionPacket(requestText);
    const brief = buildFallbackExecutionBrief({ requestText, intentId: packet.selected_intent_id });
    expect(brief.archetype_id).toBe(archetype);
    expect(brief.deliverables).not.toContain('project_created');
    if (archetype === 'resolve-approval') expect(brief.workflow_steps).toBeDefined();
  });

  it.each([
    'Webサービスを作って、その使い方の文書を書いて',
    'Build a service and write a user guide.',
  ])(
    'keeps an existing service bootstrap when documentation is also requested: %s',
    (requestText) => {
      expect(resolveIntentResolutionPacket(requestText).selected_intent_id).toBe(
        'bootstrap-project'
      );
      const brief = buildFallbackExecutionBrief({ requestText });
      expect(brief.archetype_id).toBe('bootstrap-project');
      expect(brief.deliverables).toContain('project_created');
    }
  );

  it('keeps raw fallback incident intent aligned with the resolver', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: '本番障害を収束させる。新規プロジェクトで報告書を作成する',
    });
    expect(brief.archetype_id).toBe('incident-response');
    expect(brief.deliverables).not.toContain('project_created');
  });

  it('retains explicit required inputs for a document project', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: documentProjectRequest,
      intentId: 'bootstrap-project',
      executionShape: 'project_bootstrap',
      requiredInputs: ['source_material'],
    });
    expect(brief.missing_inputs).toEqual(['source_material']);
    expect(brief.calendar_source).toBeUndefined();
  });

  it('retains an explicitly supplied calendar intent instead of reinterpreting its project topic', () => {
    const brief = buildFallbackExecutionBrief({
      requestText: documentProjectRequest,
      intentId: 'schedule-read-agenda',
      executionShape: 'direct_reply',
      requiredInputs: ['date_range'],
    });
    expect(brief.archetype_id).toBe('schedule-read-agenda');
    expect(brief.missing_inputs).not.toContain('project_brief');
    expect(brief.deliverables).not.toContain('project_created');
    expect(brief.calendar_source).toBeTruthy();
  });

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

    const bindings = (brief as any).input_bindings as Array<{
      id: string;
      type: string;
      label: string;
    }>;
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
    // The bridge is a runtime component, not an actuator (RS-07).
    expect(brief.support_components).toContain('virtual-camera-bridge');
    expect(brief.target_actuators).not.toContain('virtual-camera-bridge');
    expect(brief.target_actuators).toContain('vision-actuator');
    expect(brief.target_actuators).toContain('artifact-actuator');
  });
});
