import { describe, expect, it } from 'vitest';

import { buildPlanPreview } from './plan-preview';

describe('buildPlanPreview', () => {
  it('projects the compiled intent flow into a structured plan preview', () => {
    const preview = buildPlanPreview(
      {
        missionId: 'MSN-PREVIEW-1',
        requestText: '提案資料を作ってレビューしたい',
        tier: 'confidential',
      },
      {
        source: 'fallback',
        executionBrief: {
          kind: 'actuator-execution-brief',
          request_text: '提案資料を作ってレビューしたい',
          archetype_id: 'proposal-brief',
          summary: 'Create a proposal brief',
          user_facing_summary: 'Create a proposal brief',
          target_actuators: ['document-generator'],
          deliverables: ['artifact:doc'],
          missing_inputs: ['audience'],
          clarification_questions: [
            {
              id: 'audience',
              question: 'Who is the audience?',
              reason: 'Audience changes the structure.',
            },
          ],
          confidence: 0.8,
        } as any,
        intentContract: {
          kind: 'intent-contract',
          source_text: '提案資料を作ってレビューしたい',
          intent_id: 'proposal-brief',
          goal: {
            summary: 'Create a proposal brief',
            success_condition: 'A draft proposal brief is ready for review.',
          },
          resolution: {
            execution_shape: 'task_session',
            task_type: 'document_generation',
          },
          required_inputs: ['audience'],
          outcome_ids: ['artifact:doc'],
          approval: {
            requires_approval: true,
          },
          delivery_mode: 'managed_program',
          clarification_needed: true,
          confidence: 0.8,
          why: 'fallback',
        } as any,
        workLoop: {
          kind: 'organization-work-loop',
          workflow_id: 'wf-proposal',
          phase: 'plan',
          summary: 'Proposal workflow',
          phases: [],
        } as any,
        reasoningDecision: {
          level: 'REFLEX_DETERMINISTIC',
          rationale: 'deterministic',
        } as any,
        shadowModelRoute: {
          provider: 'claude',
          model_id: 'stub',
          rationale: 'stub',
        } as any,
      } as any
    );

    expect(preview.missionId).toBe('MSN-PREVIEW-1');
    expect(preview.goal.summary).toBe('Create a proposal brief');
    expect(preview.delivery.clarificationNeeded).toBe(true);
    expect(preview.execution.missingInputs).toEqual(['audience']);
    expect(preview.workflow).toHaveLength(0);
    expect(preview.team.assignments.length).toBeGreaterThan(0);
  });
});
