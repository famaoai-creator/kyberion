import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pathResolver,
  resolveMissionWorkflowDesign,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import type { MissionState } from './mission-types.js';
import {
  applyProcessTemplatePlan,
  evaluatePhaseEntryGate,
  evaluateStoredMissionGate,
  markPhaseTasksForRework,
  planProcessTemplateTasks,
} from './mission-process-planning.js';

const missionId = 'MSN-PROCESS-PLAN-001';
const missionPath = pathResolver.missionDir(missionId, 'public');

function presentationDesign() {
  return resolveMissionWorkflowDesign({
    missionClass: 'content_and_media',
    deliveryShape: 'single_artifact',
    riskProfile: 'review_required',
    stage: 'planning',
    executionShape: 'mission',
    intentId: 'presentation-deck',
  });
}

function makeMissionState(): MissionState {
  const design = presentationDesign();
  return {
    mission_id: missionId,
    mission_type: 'presentation_production',
    process_template: {
      workflow_id: design.workflow_id,
      pattern: design.pattern,
      phases: design.phases,
      phase_specs: design.phase_specs,
    },
    tier: 'public',
    status: 'planned',
    execution_mode: 'local',
    relationships: {},
    priority: 3,
    assigned_persona: 'worker',
    confidence_score: 1,
    git: {
      branch: 'mission/process-plan',
      start_commit: 'abc123',
      latest_commit: 'abc123',
      checkpoints: [],
    },
    history: [],
  };
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(`${missionPath}/mission-state.json`, JSON.stringify(makeMissionState(), null, 2));
  safeWriteFile(`${missionPath}/TASK_BOARD.md`, `# Task Board: ${missionId}\n`);
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('mission process planning', () => {
  it('expands the presentation process template into NEXT_TASKS.json, gates, and the task board', () => {
    const result = applyProcessTemplatePlan({
      missionId,
      missionDir: missionPath,
      design: presentationDesign(),
    });

    expect(result.skipped).toBeUndefined();
    expect(result.tasks.length).toBeGreaterThanOrEqual(6);

    const written = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as Array<Record<string, unknown>>;
    expect(written.every((task) => task.origin === 'process_template')).toBe(true);
    const phases = written.map((task) => task.phase);
    expect(phases[0]).toBe('audience_definition');
    expect(phases).toContain('review');
    expect(phases[phases.length - 1]).toBe('production_delivery');

    const review = written.find((task) => task.phase_kind === 'review');
    expect(review?.review_target).toBe('content_drafting-deck-brief');
    expect((review?.dependencies as string[]) ?? []).toContain('content_drafting-deck-brief');

    expect(result.gatePaths.length).toBeGreaterThanOrEqual(4);
    expect(safeExistsSync(`${missionPath}/gates/definitions/DECK_REVIEW_PASSED.json`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/gates/definitions/PRESENTATION_APPROVAL_GATE.json`)).toBe(
      true
    );

    const board = safeReadFile(`${missionPath}/TASK_BOARD.md`, { encoding: 'utf8' }) as string;
    expect(board).toContain('## Process Phases');
    expect(board).toContain('audience_definition');
    expect(board).toContain('exit gate: `PRESENTATION_APPROVAL_GATE`');
  });

  it('refuses to overwrite a planner-authored NEXT_TASKS.json without --force', () => {
    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify([{ task_id: 'planner-task-1', description: 'planner authored' }], null, 2)
    );

    const result = applyProcessTemplatePlan({
      missionId,
      missionDir: missionPath,
      design: presentationDesign(),
    });

    expect(result.skipped).toBe('existing_next_tasks');
    const preserved = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    );
    expect(preserved[0].task_id).toBe('planner-task-1');
  });

  it('overwrites with force and re-plans template-authored files without force', () => {
    const first = applyProcessTemplatePlan({
      missionId,
      missionDir: missionPath,
      design: presentationDesign(),
    });
    expect(first.skipped).toBeUndefined();

    // Template-authored file: re-planning without force is allowed (idempotent).
    const second = applyProcessTemplatePlan({
      missionId,
      missionDir: missionPath,
      design: presentationDesign(),
    });
    expect(second.skipped).toBeUndefined();

    safeWriteFile(
      `${missionPath}/NEXT_TASKS.json`,
      JSON.stringify([{ task_id: 'planner-task-1' }], null, 2)
    );
    const forced = applyProcessTemplatePlan({
      missionId,
      missionDir: missionPath,
      design: presentationDesign(),
      force: true,
    });
    expect(forced.skipped).toBeUndefined();
  });

  it('machine-evaluates stored gates against mission-relative evidence paths', async () => {
    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design: presentationDesign() });

    // AUDIENCE_DEFINED requires evidence/audience-brief.json — absent → fail.
    const failing = await evaluateStoredMissionGate({ missionId, gateId: 'AUDIENCE_DEFINED' });
    expect(failing.found).toBe(true);
    expect(failing.evaluation?.verdict).toBe('fail');

    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/audience-brief.json`, JSON.stringify({ audience: 'x' }));
    const passing = await evaluateStoredMissionGate({ missionId, gateId: 'AUDIENCE_DEFINED' });
    expect(passing.evaluation?.verdict).toBe('pass');
    expect(passing.phase).toBe('audience_definition');
    expect(passing.position).toBe('exit');

    // Unknown gate → not found (caller falls back to legacy flow).
    const missing = await evaluateStoredMissionGate({ missionId, gateId: 'NO_SUCH_GATE' });
    expect(missing.found).toBe(false);
  });

  it('treats operator confirmation as reviewer/human check satisfaction on gate-pass', async () => {
    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design: presentationDesign() });
    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(
      `${missionPath}/evidence/deck-brief.json`,
      JSON.stringify({
        kind: 'proposal-brief',
        slides: [
          { id: 's1' },
          { id: 's2' },
          { id: 's3' },
          { id: 's4' },
          { id: 's5' },
          { id: 's6' },
          { id: 's7' },
        ],
      })
    );

    const withoutConfirmation = await evaluateStoredMissionGate({
      missionId,
      gateId: 'DECK_REVIEW_PASSED',
    });
    expect(withoutConfirmation.evaluation?.verdict).toBe('fail');

    const confirmed = await evaluateStoredMissionGate({
      missionId,
      gateId: 'DECK_REVIEW_PASSED',
      humanConfirmed: true,
    });
    expect(confirmed.evaluation?.verdict).toBe('pass');
  });

  it('evaluates phase entry gates and flips phase tasks to rework on gate-fail', async () => {
    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design: presentationDesign() });

    // The presentation template has exit gates only; no entry gate declared.
    const noGate = await evaluatePhaseEntryGate({ missionId, phase: 'story_design' });
    expect(noGate).toBeUndefined();

    // Store a synthetic entry gate for story_design and verify deferral verdicts.
    safeWriteFile(
      `${missionPath}/gates/definitions/STORY_ENTRY.json`,
      JSON.stringify({
        mission_id: missionId,
        phase: 'story_design',
        position: 'entry',
        gate: {
          id: 'STORY_ENTRY',
          checks: [{ kind: 'evidence_exists', params: { path: 'evidence/audience-brief.json' } }],
        },
      })
    );
    const failing = await evaluatePhaseEntryGate({ missionId, phase: 'story_design' });
    expect(failing?.verdict).toBe('fail');

    safeMkdir(`${missionPath}/evidence`, { recursive: true });
    safeWriteFile(`${missionPath}/evidence/audience-brief.json`, JSON.stringify({ audience: 'x' }));
    const passing = await evaluatePhaseEntryGate({ missionId, phase: 'story_design' });
    expect(passing?.verdict).toBe('pass');

    const reworked = markPhaseTasksForRework(missionId, 'review');
    expect(reworked).toBe(1);
    const tasks = JSON.parse(
      safeReadFile(`${missionPath}/NEXT_TASKS.json`, { encoding: 'utf8' }) as string
    ) as Array<Record<string, unknown>>;
    const reviewTask = tasks.find((task) => task.phase === 'review');
    expect(reviewTask?.status).toBe('rework');
  });

  it('plan-tasks command expands from the persisted process template', async () => {
    await planProcessTemplateTasks({ id: missionId });

    expect(safeExistsSync(`${missionPath}/NEXT_TASKS.json`)).toBe(true);
    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    ) as MissionState;
    expect(state.process_template?.phase_specs?.length).toBe(6);
    expect(state.history?.some((entry) => entry.event === 'PLAN_TASKS')).toBe(true);
  });
});
