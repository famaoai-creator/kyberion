import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missionDir } from '@agent/core';
import { taskPlanToNextTasks } from '../libs/actuators/orchestrator-actuator/src/task-plan-ops.js';

/**
 * E2E-05 Task 4: sdlc-cycle contract.
 * The pipeline JSON must chain the existing modeling/orchestrator ops, and the deterministic
 * task-plan → NEXT_TASKS transform must produce worker-contract tasks
 * (reviewer tasks carry review_target + REVIEW-<target>.md).
 */

const MISSION = 'MSN-SDLC-CONTRACT';

describe('sdlc-cycle pipeline contract', () => {
  it('chains the existing SDLC ops in order', () => {
    const pipeline = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../pipelines/sdlc-cycle.json'), 'utf8')
    );
    const ops = pipeline.steps.map((step: { op: string }) => step.op);
    expect(ops).toEqual([
      'system:log',
      'system:write_artifact',
      'modeling:extract_requirements',
      'modeling:extract_design_spec',
      'orchestrator:decompose_into_tasks',
      'orchestrator:task_plan_to_next_tasks',
      'modeling:extract_test_plan',
      'system:log',
    ]);
    expect(pipeline.context).toHaveProperty('mission_id');
    expect(pipeline.context).toHaveProperty('intent_text');
  });
});

describe('task_plan_to_next_tasks (deterministic transform)', () => {
  let missionPath: string;
  let prevRole: string | undefined;

  beforeEach(() => {
    prevRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
    missionPath = missionDir(MISSION, 'public');
    fs.mkdirSync(path.join(missionPath, 'evidence'), { recursive: true });
    fs.writeFileSync(
      path.join(missionPath, 'evidence', 'task-plan.json'),
      JSON.stringify({
        version: '1.0.0',
        project_name: 'FixtureApp',
        generated_at: '2026-07-07T00:00:00Z',
        tasks: [
          {
            task_id: 'T-1',
            title: 'Implement login',
            summary: 'Build the login form',
            priority: 'must',
            estimate: 'M',
            deliverables: ['deliverables/login.md'],
            test_criteria: ['user can log in'],
            assigned_role: 'implementer',
          },
          {
            task_id: 'T-2',
            title: 'Review login',
            summary: 'Review the login implementation',
            priority: 'must',
            estimate: 'S',
            depends_on: ['T-1'],
            assigned_role: 'reviewer',
          },
          {
            task_id: 'T-3',
            title: 'Verify login flows',
            summary: 'Run the test plan',
            priority: 'should',
            estimate: 'XL',
            depends_on: ['T-1'],
            assigned_role: 'tester',
          },
          {
            task_id: 'T-4',
            title: 'Orphan review',
            summary: 'Reviewer without dependencies degrades to implementer',
            priority: 'could',
            estimate: 'S',
            assigned_role: 'reviewer',
          },
        ],
      })
    );
  });

  afterEach(() => {
    if (prevRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = prevRole;
    fs.rmSync(missionPath, { recursive: true, force: true });
  });

  it('maps the plan into worker-contract NEXT_TASKS', () => {
    const result = taskPlanToNextTasks({ mission_id: MISSION });
    expect(result.task_count).toBe(4);
    const tasks = JSON.parse(fs.readFileSync(path.join(missionPath, 'NEXT_TASKS.json'), 'utf8'));

    const [implement, review, qa, orphan] = tasks;
    expect(implement).toMatchObject({
      task_id: 'T-1',
      status: 'planned',
      assigned_to: { role: 'implementer' },
      deliverable: 'deliverables/login.md',
      estimated_scope: 'M',
      risk: 'medium',
    });
    expect(implement.acceptance_criteria).toEqual(['user can log in']);

    expect(review).toMatchObject({
      task_id: 'T-2',
      assigned_to: { role: 'reviewer' },
      review_target: 'T-1',
      deliverable: 'deliverables/REVIEW-T-1.md',
      dependencies: ['T-1'],
    });

    expect(qa).toMatchObject({
      task_id: 'T-3',
      assigned_to: { role: 'qa' },
      review_target: 'T-1',
      deliverable: 'deliverables/REVIEW-T-1.md',
      estimated_scope: 'L',
      risk: 'high',
    });

    expect(orphan.assigned_to.role).toBe('implementer');
    expect(orphan.review_target).toBeUndefined();
  });
});
