import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  safeMkdir,
  safeWriteFile,
  safeRmSync,
  safeReadFile,
  safeReaddir,
  safeStat,
} from '../secure-io.js';
import {
  collectMissionFlowProjection,
  projectMissionApprovalBlockers,
} from './mission-flow-projection.js';
import type { MissionState } from './mission-types.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';

const missionId = 'MSN-FLOW-UNIT';
const dir = pathResolver.sharedTmp(`mission-flow-projection/${missionId}`);
const state: MissionState = {
  mission_id: missionId,
  tier: 'public',
  status: 'active',
  execution_mode: 'local',
  priority: 1,
  assigned_persona: 'fixture',
  confidence_score: 1,
  intent: { goal_summary: 'Deliver verified change', success_condition: 'Unit tests pass' },
  git: { branch: 'fixture', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
  history: [],
};
function write(name: string, value: unknown) {
  safeWriteFile(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value), {
    mkdir: true,
  });
}
function observe(overrides: Partial<MissionState> = {}) {
  return collectMissionFlowProjection({
    missionId,
    state: { ...state, ...overrides },
    missionDir: dir,
    recommendation: {
      action: overrides.status === 'paused' || overrides.status === 'planned' ? 'start' : 'verify',
      reason: 'Lifecycle candidate',
      commands: [],
    },
    driftBlocked: false,
  });
}
function hash() {
  const result = createHash('sha256');
  function walk(root: string) {
    for (const name of safeReaddir(root).sort()) {
      const file = path.join(root, name);
      if (safeStat(file).isDirectory()) walk(file);
      else {
        result.update(file);
        result.update(safeReadFile(file));
      }
    }
  }
  walk(dir);
  return result.digest('hex');
}
beforeEach(() => {
  safeMkdir(dir, { recursive: true });
});
afterEach(() => {
  safeRmSync(dir, { recursive: true, force: true });
});

describe('mission flow read-only observations', () => {
  it('does not turn a missing or malformed task board into closed tasks', () => {
    expect(observe()).toMatchObject({ disposition: 'unknown', task_board: 'missing' });
    write('NEXT_TASKS.json', '{"not":"an array"}');
    expect(observe()).toMatchObject({ disposition: 'unknown', task_board: 'unreadable' });
    write('NEXT_TASKS.json', [{ task_id: 'a', dependencies: 'b' }]);
    expect(observe().task_board).toBe('unreadable');
    write('NEXT_TASKS.json', [{ task_id: 'a' }, { task_id: 'a' }]);
    expect(observe().task_board).toBe('unreadable');
  });
  it('identifies unfinished tasks and dependency evidence without dispatching work', () => {
    write('NEXT_TASKS.json', [
      { task_id: 'a', status: 'planned' },
      { task_id: 'b', status: 'planned', dependencies: ['a'] },
    ]);
    const flow = observe();
    expect(flow.blockers.map((row) => row.code)).toEqual(['unfinished_task', 'task_dependency']);
    expect(flow.candidates[0]).toMatchObject({ action: 'continue_task', task_id: 'a' });
    expect(flow.candidates[0].evidence_refs[0]).toContain('NEXT_TASKS.json#a');
    expect(flow.runtime.state).toBe('unknown');
  });
  it('reports missing prerequisite evidence', () => {
    write('NEXT_TASKS.json', []);
    expect(
      observe({ status: 'planned', relationships: { prerequisites: ['MSN-NO-SUCH-PREREQUISITE'] } })
        .blockers[0]
    ).toMatchObject({ code: 'mission_prerequisite' });
  });
  it.each([
    [{ task_id: 'a', dependencies: ['a'] }],
    [{ task_id: 'a', dependencies: ['missing'] }],
    [
      { task_id: 'a', dependencies: ['b'] },
      { task_id: 'b', dependencies: ['a'] },
    ],
  ])('does not suggest work from an invalid dependency graph', (...tasks) => {
    write('NEXT_TASKS.json', tasks);
    expect(observe().task_board).toBe('unreadable');
  });
  it('does not equate reviewed dependencies with the dispatchers completed status', () => {
    write('NEXT_TASKS.json', [
      { task_id: 'a', status: 'reviewed' },
      { task_id: 'b', status: 'planned', dependencies: ['a'] },
    ]);
    expect(observe().candidates[0].action).toBe('inspect_task_dependency');
    write('NEXT_TASKS.json', [
      { task_id: 'a', status: 'completed' },
      { task_id: 'b', status: 'planned', dependencies: ['a'] },
    ]);
    expect(observe().candidates[0].action).toBe('continue_task');
  });
  it('suggests activation before continuing a paused mission', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'planned' }]);
    expect(observe({ status: 'paused' }).candidates[0].action).toBe('start');
  });
  it('uses the same normalized task graph as the dispatcher', () => {
    write('NEXT_TASKS.json', [
      { task_id: ' a ', status: ' completed ' },
      { task_id: ' b ', status: 'planned', dependencies: [' a '] },
    ]);
    expect(observe().candidates[0]).toMatchObject({ action: 'continue_task', task_id: 'b' });
  });
  it('retains failed checks and rejection even if a historic override says pass', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'completed' }]);
    write('gates/TESTS.json', {
      mission_id: missionId,
      gate_id: 'TESTS',
      verdict: 'fail',
      checked_at: '2026-01-01T00:00:00Z',
      reasons: ['Unit tests failed'],
    });
    write('gates/TESTS-override.json', {
      mission_id: missionId,
      gate_id: 'TESTS-override',
      source_gate_id: 'TESTS',
      verdict: 'pass',
      override: true,
      checked_at: '2026-01-02T00:00:00Z',
    });
    const flow = observe({
      verification: {
        status: 'rejected',
        verified_at: '2026-01-01T00:00:00Z',
        note: 'Unit tests failed',
      },
    });
    expect(flow.blockers.map((row) => row.code)).toContain('recorded_gate_failure');
    expect(flow.blockers.map((row) => row.code)).toContain('verification_rejected');
    expect(flow.completion.structural).toBe('unsatisfied');
  });
  it('keeps malformed or cross-mission gate records unknown', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'planned' }]);
    write('gates/OTHER.json', { mission_id: 'MSN-OTHER', gate_id: 'TESTS', verdict: 'pass' });
    expect(observe().blockers[0].code).toBe('observation_unreadable');
  });

  it('orders gate observations by instant rather than filename or timezone text', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'planned' }]);
    write('gates/a-pass.json', {
      mission_id: missionId,
      gate_id: 'TESTS',
      verdict: 'pass',
      checked_at: '2026-01-01T01:00:00Z',
    });
    write('gates/z-fail.json', {
      mission_id: missionId,
      gate_id: 'TESTS',
      verdict: 'fail',
      checked_at: '2026-01-01T09:00:00+09:00',
    });
    expect(observe().blockers.some((row) => row.code === 'recorded_gate_failure')).toBe(false);
    write('gates/invalid.json', {
      mission_id: missionId,
      gate_id: 'TESTS',
      verdict: 'pass',
      checked_at: 'invalid',
    });
    expect(observe().disposition).toBe('unknown');
  });
  it('does not erase an undated failure with a dated pass', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'planned' }]);
    write('gates/fail.json', { mission_id: missionId, gate_id: 'TESTS', verdict: 'fail' });
    write('gates/pass.json', {
      mission_id: missionId,
      gate_id: 'TESTS',
      verdict: 'pass',
      checked_at: '2026-01-01T00:00:00Z',
    });
    expect(observe().disposition).toBe('unknown');
  });
  it('changes the candidate only when structural evidence changes, without writing during reads', () => {
    write('NEXT_TASKS.json', [{ task_id: 'a', status: 'completed' }]);
    const before = hash();
    expect(observe().completion.structural).toBe('unsatisfied');
    expect(hash()).toBe(before);
    write('evidence/tests.md', 'Unit tests pass');
    const withEvidence = hash();
    const flow = observe();
    expect(flow.completion.structural).toBe('satisfied');
    expect(flow.candidates[0].action).toBe('verify');
    expect(flow.authority).toBe('none');
    expect(flow.freshness.revalidate_on_execution).toBe(true);
    expect(hash()).toBe(withEvidence);
    expect(observe().candidates).toEqual(flow.candidates);
    expect(hash()).toBe(withEvidence);
  });
  it('distinguishes terminal lifecycle from merge and deployment', () => {
    expect(observe({ status: 'completed' })).toMatchObject({
      disposition: 'terminal',
      completion: { merge: 'not_assessed', deployment: 'not_assessed' },
    });
  });
});

describe('approval observation projection (in-memory, no approval store writes)', () => {
  function record(overrides: Partial<ApprovalRequestRecord> = {}): ApprovalRequestRecord {
    return {
      id: '11111111-1111-4111-8111-111111111111',
      storageChannel: 'fixture',
      status: 'pending',
      scope: { scope_kind: 'mission', tier: 'public', mission_id: missionId },
      ...overrides,
    } as ApprovalRequestRecord;
  }
  it('distinguishes pending and expired observations without granting authority', () => {
    expect(projectMissionApprovalBlockers(state, [record()], Date.now())[0].code).toBe(
      'approval_pending'
    );
    expect(
      projectMissionApprovalBlockers(
        state,
        [record({ expiresAt: '2000-01-01T00:00:00Z' })],
        Date.now()
      )[0].code
    ).toBe('approval_expired');
    expect(
      projectMissionApprovalBlockers(state, [record({ status: 'approved' })], Date.now())
    ).toEqual([]);
    expect(
      projectMissionApprovalBlockers(
        state,
        [record({ status: 'applied', expiresAt: '2000-01-01T00:00:00Z' })],
        Date.now()
      )
    ).toEqual([]);
  });
  it('never associates unscoped, cross-tenant, or cross-mission records by name', () => {
    expect(
      projectMissionApprovalBlockers(
        state,
        [
          record({ scope: undefined, source: { missionId } }),
          record({
            scope: {
              scope_kind: 'mission',
              tier: 'public',
              mission_id: missionId,
              tenant_slug: 'other-tenant',
            },
          }),
          record({ scope: { scope_kind: 'mission', tier: 'public', mission_id: 'MSN-OTHER' } }),
        ],
        Date.now()
      )
    ).toEqual([]);
  });
  it('does not request a fresh decision for successfully applied approved records', () => {
    const applied = record({ status: 'approved', expiresAt: '2000-01-01T00:00:00Z' });
    applied.applyResult = {
      result: 'success',
      appliedAt: '2000-01-01T00:00:00Z',
    } as ApprovalRequestRecord['applyResult'];
    expect(projectMissionApprovalBlockers(state, [applied], Date.now())).toEqual([]);
  });
});
