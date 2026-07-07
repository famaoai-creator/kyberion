import { describe, expect, it } from 'vitest';
import {
  normalizeWorkflowPhases,
  resolveMissionWorkflowDesign,
} from './mission-workflow-catalog.js';

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
    // MO-01: the AI-DLC template now carries per-phase task specs and gates.
    expect(workflow.phase_specs?.length).toBe(workflow.phases.length);
    const selfReview = workflow.phase_specs?.find((phase) => phase.id === 'self_review');
    expect(selfReview?.kind).toBe('review');
    expect(selfReview?.exit_gate?.id).toBe('CODE_REVIEW_PASSED');
  });

  it('selects the incident analysis post-mortem process for incident intents', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'incident-analysis',
    });

    expect(workflow.workflow_id).toBe('incident-analysis-postmortem');
    expect(workflow.phases).toEqual([
      'triage',
      'evidence_collection',
      'timeline_reconstruction',
      'root_cause_analysis',
      'review',
      'report_delivery',
    ]);
    expect(workflow.phase_specs?.[5]?.exit_gate?.id).toBe('INCIDENT_REPORT_SIGNOFF');
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

  it('normalizes mixed string/object phases into ids plus specs', () => {
    const { ids, specs, hasSpecEntries } = normalizeWorkflowPhases([
      'intake',
      {
        id: 'review',
        kind: 'review',
        exit_gate: { id: 'REVIEW_PASSED', checks: [{ kind: 'reviewer_approved' }] },
        default_tasks: [
          {
            task_id_suffix: 'content-review',
            description: 'Review the drafted deliverable for consistency.',
            phase_kind: 'review',
          },
        ],
      },
    ]);

    expect(ids).toEqual(['intake', 'review']);
    expect(hasSpecEntries).toBe(true);
    expect(specs[0]).toEqual({ id: 'intake' });
    expect(specs[1]?.exit_gate?.id).toBe('REVIEW_PASSED');
    expect(specs[1]?.default_tasks?.[0]?.task_id_suffix).toBe('content-review');
  });

  it('keeps legacy string-only templates free of phase_specs', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'code_change',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'execution',
      executionShape: 'task_session',
    });

    expect(workflow.workflow_id).toBe('single-track-default');
    expect(workflow.phase_specs).toBeUndefined();
  });

  it('selects the presentation deck production process for presentation intents', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'presentation-deck',
    });

    expect(workflow.workflow_id).toBe('presentation-deck-production');
    expect(workflow.phases).toEqual([
      'audience_definition',
      'story_design',
      'content_drafting',
      'design_selection',
      'review',
      'production_delivery',
    ]);
    expect(workflow.phase_specs?.length).toBe(6);
    expect(workflow.phase_specs?.[4]?.kind).toBe('review');
    expect(workflow.phase_specs?.[5]?.exit_gate?.id).toBe('PRESENTATION_APPROVAL_GATE');
  });

  it('routes the presentation_production mission-type hint onto the deck process', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      missionTypeHint: 'presentation_production',
    });

    expect(workflow.workflow_id).toBe('presentation-deck-production');
  });

  it('selects the document authoring process for document intents', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'write-report',
    });

    expect(workflow.workflow_id).toBe('document-authoring');
    expect(workflow.phases).toContain('outline_design');
  });

  it('does not hijack generate-presentation intents onto the new deck process', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'generate-presentation',
    });

    // Pre-existing routing (coordinated-multi-track shadows the narration
    // template for multi_artifact_pipeline) must not be disturbed by the new
    // process templates.
    expect(['presentation-deck-production', 'document-authoring']).not.toContain(
      workflow.workflow_id
    );
  });

  it('selects the deck process for presentation intents on multi-artifact missions too', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'content_and_media',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'proposal-deck',
    });

    expect(workflow.workflow_id).toBe('presentation-deck-production');
  });

  it('routes each business process intent onto its dedicated rich template', () => {
    const cases = [
      {
        intentId: 'research-report',
        missionClass: 'research_and_absorption',
        deliveryShape: 'single_artifact',
        expected: 'research-report',
      },
      {
        intentId: 'data-analysis',
        missionClass: 'decision_support',
        deliveryShape: 'single_artifact',
        expected: 'data-analysis-report',
      },
      {
        intentId: 'marketing-campaign',
        missionClass: 'content_and_media',
        deliveryShape: 'multi_artifact_pipeline',
        expected: 'marketing-campaign-production',
      },
      {
        intentId: 'contract-review',
        missionClass: 'decision_support',
        deliveryShape: 'single_artifact',
        expected: 'contract-review-approval',
      },
      {
        intentId: 'customer-onboarding',
        missionClass: 'customer_engagement',
        deliveryShape: 'single_artifact',
        expected: 'customer-onboarding-engagement',
      },
      {
        intentId: 'training-material',
        missionClass: 'content_and_media',
        deliveryShape: 'single_artifact',
        expected: 'training-material-authoring',
      },
      {
        intentId: 'event-planning',
        missionClass: 'operations_and_release',
        deliveryShape: 'multi_artifact_pipeline',
        expected: 'event-planning-operations',
      },
    ] as const;

    for (const testCase of cases) {
      const workflow = resolveMissionWorkflowDesign({
        missionClass: testCase.missionClass,
        deliveryShape: testCase.deliveryShape,
        riskProfile: 'review_required',
        stage: 'planning',
        executionShape: 'mission',
        intentId: testCase.intentId,
      });
      expect(workflow.workflow_id, `intent ${testCase.intentId}`).toBe(testCase.expected);
      // Every dedicated process template must be fully executable (MO-01).
      expect(
        workflow.phase_specs?.some((phase) => phase.default_tasks?.length),
        `intent ${testCase.intentId} has default tasks`
      ).toBe(true);
      expect(
        workflow.phase_specs?.some((phase) => phase.kind === 'review'),
        `intent ${testCase.intentId} has a review phase`
      ).toBe(true);
    }
  });

  it('enriches the CO-05 business templates with phase specs while keeping their phase ids', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      intentId: 'hiring-workflow',
    });

    expect(workflow.workflow_id).toBe('hiring-workflow');
    expect(workflow.phases).toEqual([
      'intake',
      'classification',
      'planning',
      'contract_authoring',
      'preflight',
      'execution',
      'verification',
      'delivery',
    ]);
    const verification = workflow.phase_specs?.find((phase) => phase.id === 'verification');
    expect(verification?.kind).toBe('review');
    expect(verification?.exit_gate?.id).toBe('HIRING_KIT_REVIEWED');
    const delivery = workflow.phase_specs?.find((phase) => phase.id === 'delivery');
    expect(delivery?.exit_gate?.checks.some((check) => check.kind === 'human_override')).toBe(true);
  });

  it('routes the research_report mission-type hint onto the research process', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'research_and_absorption',
      deliveryShape: 'single_artifact',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      missionTypeHint: 'research_report',
    });

    expect(workflow.workflow_id).toBe('research-report');
  });

  it('selects the meeting facilitator follow-up workflow for meeting facilitation missions', () => {
    const workflow = resolveMissionWorkflowDesign({
      missionClass: 'operations_and_release',
      deliveryShape: 'multi_artifact_pipeline',
      riskProfile: 'review_required',
      stage: 'planning',
      executionShape: 'mission',
      missionTypeHint: 'meeting_facilitation',
    });

    expect(workflow.workflow_id).toBe('ai-meeting-facilitator-followup');
    expect(workflow.phases).toEqual(
      expect.arrayContaining([
        'agenda_and_role_boundary',
        'live_facilitation',
        'postprocess',
        'self_execution',
        'team_tracking',
        'delivery',
      ])
    );
  });
});
