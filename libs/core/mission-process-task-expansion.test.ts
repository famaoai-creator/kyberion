import { describe, expect, it } from 'vitest';
import {
  expandProcessTemplateTasks,
  processTemplateGateDefinitions,
} from './mission-process-task-expansion.js';
import type { WorkflowPhaseSpec } from './mission-workflow-catalog.js';

const PRESENTATION_LIKE_PHASES: WorkflowPhaseSpec[] = [
  {
    id: 'audience_definition',
    kind: 'judgment',
    default_tasks: [
      {
        task_id_suffix: 'audience-brief',
        description: 'Define the target audience and desired action in audience-brief.json.',
        deliverable: 'evidence/audience-brief.json',
        acceptance_criteria: ['audience and desired_action are present'],
        expected_output_format: 'structured',
        estimated_scope: 'S',
        risk: 'low',
      },
    ],
    exit_gate: {
      id: 'AUDIENCE_DEFINED',
      checks: [{ kind: 'evidence_exists', params: { path: 'evidence/audience-brief.json' } }],
    },
  },
  {
    id: 'story_design',
    kind: 'judgment',
    default_tasks: [
      {
        task_id_suffix: 'storyline',
        description: 'Design core message and supporting points for {MISSION_ID}.',
        deliverable: 'evidence/story-outline.json',
        acceptance_criteria: ['core_message is a single sentence'],
      },
    ],
  },
  {
    id: 'review',
    kind: 'review',
    default_tasks: [
      {
        task_id_suffix: 'content-review',
        description: 'Review the storyline for audience fit and narrative consistency.',
        review_target_suffix: 'storyline',
        acceptance_criteria: ['core message aligns with audience brief'],
      },
    ],
    exit_gate: {
      id: 'DECK_REVIEW_PASSED',
      checks: [
        { kind: 'reviewer_approved' },
        {
          kind: 'deliverable_quality',
          params: { path: 'evidence/story-outline.json', kind: 'deck', min_score: 0.7 },
        },
      ],
    },
  },
];

describe('mission-process-task-expansion', () => {
  it('chains dependencies across task-bearing phases', () => {
    const tasks = expandProcessTemplateTasks({
      missionId: 'MSN-TEST-001',
      design: {
        workflow_id: 'presentation-deck-production',
        phase_specs: PRESENTATION_LIKE_PHASES,
      },
    });

    expect(tasks.map((task) => task.task_id)).toEqual([
      'audience_definition-audience-brief',
      'story_design-storyline',
      'review-content-review',
    ]);
    expect(tasks[0]?.dependencies).toEqual([]);
    expect(tasks[1]?.dependencies).toEqual(['audience_definition-audience-brief']);
    expect(tasks[2]?.dependencies).toContain('story_design-storyline');
    expect(tasks.every((task) => task.origin === 'process_template')).toBe(true);
    expect(tasks.every((task) => task.status === 'planned')).toBe(true);
  });

  it('substitutes {MISSION_ID} placeholders in descriptions and deliverables', () => {
    const tasks = expandProcessTemplateTasks({
      missionId: 'MSN-TEST-002',
      design: {
        workflow_id: 'w',
        phase_specs: [
          {
            id: 'drafting',
            default_tasks: [
              {
                task_id_suffix: 'draft',
                description: 'Draft the report for {MISSION_ID}.',
                deliverable: 'evidence/{MISSION_ID}-report.md',
              },
            ],
          },
        ],
      },
    });

    expect(tasks[0]?.description).toBe('Draft the report for MSN-TEST-002.');
    expect(tasks[0]?.deliverable).toBe('evidence/MSN-TEST-002-report.md');
  });

  it('produces reviewer tasks satisfying the orchestration worker invariants', () => {
    const tasks = expandProcessTemplateTasks({
      missionId: 'MSN-TEST-003',
      design: { workflow_id: 'w', phase_specs: PRESENTATION_LIKE_PHASES },
    });

    const review = tasks.find((task) => task.phase_kind === 'review');
    expect(review?.assigned_to.role).toBe('reviewer');
    expect(review?.review_target).toBe('story_design-storyline');
    expect(review?.dependencies).toContain('story_design-storyline');
    expect(review?.deliverable).toBe('evidence/REVIEW-story_design-storyline.md');
  });

  it('rejects review tasks whose target suffix cannot be resolved', () => {
    expect(() =>
      expandProcessTemplateTasks({
        missionId: 'MSN-TEST-004',
        design: {
          workflow_id: 'w',
          phase_specs: [
            {
              id: 'review',
              kind: 'review',
              default_tasks: [
                {
                  task_id_suffix: 'orphan-review',
                  description: 'Review a task that does not exist anywhere.',
                  review_target_suffix: 'missing-task',
                },
              ],
            },
          ],
        },
      })
    ).toThrow(/unknown task suffix missing-task/);
  });

  it('rejects review tasks with a mismatched deliverable basename', () => {
    expect(() =>
      expandProcessTemplateTasks({
        missionId: 'MSN-TEST-005',
        design: {
          workflow_id: 'w',
          phase_specs: [
            {
              id: 'draft',
              default_tasks: [
                { task_id_suffix: 'doc', description: 'Draft the target document body.' },
              ],
            },
            {
              id: 'review',
              kind: 'review',
              default_tasks: [
                {
                  task_id_suffix: 'doc-review',
                  description: 'Review the drafted document deliverable.',
                  review_target_suffix: 'doc',
                  deliverable: 'evidence/wrong-name.md',
                },
              ],
            },
          ],
        },
      })
    ).toThrow(/REVIEW-draft-doc\.md/);
  });

  it('is deterministic for a given design', () => {
    const run = () =>
      expandProcessTemplateTasks({
        missionId: 'MSN-TEST-006',
        design: { workflow_id: 'w', phase_specs: PRESENTATION_LIKE_PHASES },
      });
    expect(run()).toEqual(run());
  });

  it('collects entry/exit gate definitions in phase order with placeholders substituted', () => {
    const gates = processTemplateGateDefinitions('MSN-TEST-007', {
      phase_specs: [
        {
          id: 'production',
          entry_gate: {
            id: 'CONTENT_READY',
            checks: [
              { kind: 'evidence_exists', params: { path: 'evidence/{MISSION_ID}-brief.json' } },
            ],
          },
          exit_gate: { id: 'DELIVERY_APPROVED', checks: [{ kind: 'human_override' }] },
        },
      ],
    });

    expect(gates.map((gate) => `${gate.phase}:${gate.position}:${gate.gate.id}`)).toEqual([
      'production:entry:CONTENT_READY',
      'production:exit:DELIVERY_APPROVED',
    ]);
    expect(gates[0]?.gate.checks[0]?.params?.path).toBe('evidence/MSN-TEST-007-brief.json');
  });

  it('returns no tasks for designs without phase specs', () => {
    expect(
      expandProcessTemplateTasks({ missionId: 'MSN-TEST-008', design: { workflow_id: 'w' } })
    ).toEqual([]);
  });
});
