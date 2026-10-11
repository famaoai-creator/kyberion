import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { collectMissionTriageReport, draftScopeRebaselineGoal } from './mission-triage.js';
import { safeExec, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

const missionId = 'MSN-TRIAGE-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');

function currentCommit(): string {
  return safeExec('git', ['rev-parse', 'HEAD'], { cwd: pathResolver.rootDir() }).trim();
}

function prepareMission(
  status: string,
  overrides?: Record<string, unknown>,
  tasks?: Array<Record<string, unknown>>
): void {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    nodePath.join(missionPath, 'mission-state.json'),
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status,
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'triage-test-actor',
        confidence_score: 1,
        intent: { goal_summary: 'original mission goal' },
        git: {
          branch: 'test',
          start_commit: currentCommit(),
          latest_commit: currentCommit(),
          checkpoints: [],
        },
        history: [],
        context: {},
        ...overrides,
      },
      null,
      2
    )
  );
  if (tasks) {
    safeWriteFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(tasks, null, 2));
  }
}

const pendingTask = { task_id: 'task-a', status: 'planned', description: 'do A' };
const doneTask = { task_id: 'task-b', status: 'completed', description: 'did B' };

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'triage-test-actor';
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
});

describe('collectMissionTriageReport', () => {
  it('reports not_found for a mission with no directory', () => {
    const report = collectMissionTriageReport('MSN-TRIAGE-MISSING');
    expect(report.found).toBe(false);
    expect(report.classification).toBe('not_found');
    expect(report.recommendation.action).toBe('none');
  });

  it('classifies a planned mission as not_started', () => {
    prepareMission('planned');
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('not_started');
    expect(report.recommendation.action).toBe('start');
  });

  it('classifies an active mission with pending tasks as in_progress', () => {
    prepareMission('active', {}, [pendingTask, doneTask]);
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('in_progress');
    expect(report.tasks.pending).toEqual(['task-a']);
    expect(report.recommendation.commands.join('\n')).toContain('record-evidence');
  });

  it('classifies an active mission with no pending tasks as ready_to_verify', () => {
    prepareMission('active', {}, [doneTask]);
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('ready_to_verify');
    expect(report.recommendation.commands.join(' ')).toContain('verify');
  });

  it('classifies a validating mission with recorded drift failures as intent_drift_blocked', () => {
    prepareMission('validating', {
      context: { intent_drift_gate_failure_count: 2 },
    });
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('intent_drift_blocked');
    expect(report.recommendation.action).toBe('scope_rebaseline');
    const commands = report.recommendation.commands.join('\n');
    expect(commands).toContain('scope-approve');
    expect(commands).toContain('--request-approval');
    expect(commands).toContain('kyberion approvals --approve');
    expect(commands).toContain('cancel');
  });

  it('preserves completed lifecycle but requires closure inspection instead of archive advice', () => {
    prepareMission('completed');
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('terminal');
    expect(report.flow).toMatchObject({
      observed_status: 'completed',
      disposition: 'unknown',
      task_board: 'missing',
    });
    expect(report.recommendation.action).toBe('inspect');
    expect(report.recommendation.commands).toEqual([]);
  });

  it('aligns completed legacy recommendation with pending closure work', () => {
    prepareMission('completed', {}, [pendingTask]);
    const report = collectMissionTriageReport(missionId);
    expect(report.recommendation.action).toBe('continue');
    expect(report.recommendation.reason).toBe(report.flow.candidates[0].reason);
    expect(report.recommendation.commands).toEqual([]);
  });

  it('offers governed finish only after completed closure proof is observed', () => {
    prepareMission(
      'completed',
      {
        intent: {
          goal_summary: 'original mission goal',
          success_condition: 'original mission goal',
        },
      },
      [doneTask]
    );
    safeWriteFile(nodePath.join(missionPath, 'evidence/tests.md'), 'original mission goal', {
      mkdir: true,
    });
    const report = collectMissionTriageReport(missionId);
    expect(report.flow.candidates[0].action).toBe('finish');
    expect(report.recommendation.action).toBe('finish');
    expect(report.recommendation.commands).toEqual([`pnpm mission finish ${missionId}`]);
  });

  it('finds a finished mission in the archive instead of reporting not_found', () => {
    const archivedId = 'MSN-TRIAGE-ARCHIVED';
    const archiveDir = pathResolver.archivedMissionDir(archivedId);
    try {
      safeMkdir(archiveDir, { recursive: true });
      safeWriteFile(
        nodePath.join(archiveDir, 'mission-state.json'),
        JSON.stringify({
          mission_id: archivedId,
          tier: 'public',
          status: 'archived',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'triage-test-actor',
          confidence_score: 1,
          git: { branch: 'test', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
          history: [],
        })
      );
      const report = collectMissionTriageReport(archivedId);
      expect(report.classification).toBe('terminal');
      expect(report.status).toBe('archived');
    } finally {
      safeRmSync(archiveDir, { recursive: true, force: true });
    }
  });

  it('classifies a distilling mission with pending tasks as unfinished_tasks', () => {
    prepareMission('distilling', {}, [pendingTask]);
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('unfinished_tasks');
    expect(report.recommendation.commands.join('\n')).toContain('reconcile-work');
  });

  it('classifies a distilling mission with no pending tasks as awaiting_finish', () => {
    prepareMission('distilling', {}, [doneTask]);
    const report = collectMissionTriageReport(missionId);
    expect(report.classification).toBe('awaiting_finish');
    expect(report.recommendation.commands.join(' ')).toContain('finish');
  });
});

describe('draftScopeRebaselineGoal', () => {
  it('prefers the explicit goal', () => {
    prepareMission('validating');
    expect(draftScopeRebaselineGoal(missionId, 'explicit goal')).toBe('explicit goal');
  });

  it('drafts from the original goal plus delivered evidence', () => {
    prepareMission('validating');
    safeMkdir(nodePath.join(missionPath, 'evidence'), { recursive: true });
    safeWriteFile(nodePath.join(missionPath, 'evidence', 'delivery-report.md'), 'done');
    const drafted = draftScopeRebaselineGoal(missionId);
    expect(drafted).toContain('original mission goal');
    expect(drafted).toContain('delivery-report.md');
  });
});
