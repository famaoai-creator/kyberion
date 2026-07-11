import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  advanceAiDlcPhase,
  createAiDlcPhaseState,
  loadAiDlcPhaseState,
  saveAiDlcPhaseState,
  tripAiDlcCircuitBreaker,
} from './aidlc-phase-state.js';

const NOW = '2026-07-11T12:00:00.000Z';

describe('aidlc-phase-state (HO-02 Task 1)', () => {
  it('threads structured results phase to phase (Execution → Test → Self-Review)', () => {
    let state = createAiDlcPhaseState('MSN-AIDLC-1', {
      taskBoardRef: 'artifact:board-1',
      now: NOW,
    });
    expect(state.phase).toBe('alignment');

    state = advanceAiDlcPhase(
      state,
      {
        phase: 'execution',
        result: { summary: 'patched module X', artifact_refs: ['artifact:diff-1'] },
      },
      NOW
    );
    expect(state.phase).toBe('execution');

    state = advanceAiDlcPhase(
      state,
      {
        phase: 'test',
        result: { summary: '12 tests green', passed: true, artifact_refs: ['artifact:test-log'] },
      },
      NOW
    );
    // The test phase received the execution result as data, not a re-derived diff.
    expect(state.execution_result?.artifact_refs).toEqual(['artifact:diff-1']);

    state = advanceAiDlcPhase(
      state,
      {
        phase: 'self_review',
        result: { summary: 'no findings', approved: true, artifact_refs: [] },
      },
      NOW
    );
    expect(state.phase).toBe('complete');
    expect(state.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual([
      'execution:passed',
      'test:passed',
      'self_review:passed',
    ]);
  });

  it('rejects out-of-order transitions', () => {
    const state = createAiDlcPhaseState('MSN-AIDLC-2', { now: NOW });
    expect(() =>
      advanceAiDlcPhase(
        state,
        { phase: 'test', result: { summary: 'x', passed: true, artifact_refs: [] } },
        NOW
      )
    ).toThrow(/invalid transition/);
  });

  it('a failed test gate trips the circuit breaker back to alignment with failure_context', () => {
    let state = createAiDlcPhaseState('MSN-AIDLC-3', { now: NOW });
    state = advanceAiDlcPhase(
      state,
      { phase: 'execution', result: { summary: 'patched', artifact_refs: [] } },
      NOW
    );
    state = advanceAiDlcPhase(
      state,
      {
        phase: 'test',
        result: { summary: '3 tests red', passed: false, artifact_refs: ['artifact:fail-log'] },
      },
      NOW
    );

    expect(state.phase).toBe('alignment');
    expect(state.failure_context).toMatchObject({
      failed_phase: 'test',
      what_failed: '3 tests red',
    });
    expect(state.failure_context?.attempted).toContain('execution:passed');
    // The failed test output is preserved for the re-planning phase.
    expect(state.test_output?.artifact_refs).toEqual(['artifact:fail-log']);
  });

  it('manual circuit-breaker trips carry open questions', () => {
    const state = createAiDlcPhaseState('MSN-AIDLC-4', { now: NOW });
    const tripped = tripAiDlcCircuitBreaker(
      state,
      {
        failed_phase: 'execution',
        what_failed: 'blocked on missing credentials',
        attempted: [],
        open_questions: ['which account should the integration use?'],
      },
      NOW
    );
    expect(tripped.phase).toBe('alignment');
    expect(tripped.failure_context?.open_questions).toHaveLength(1);
  });

  it('persists and reloads through the mission evidence path shape', () => {
    const baseDir = path.join(pathResolver.active('shared/tmp/tests'), `aidlc-state-${Date.now()}`);
    let state = createAiDlcPhaseState('MSN-AIDLC-5', { now: NOW });
    state = advanceAiDlcPhase(
      state,
      { phase: 'execution', result: { summary: 'done', artifact_refs: [] } },
      NOW
    );
    const filePath = saveAiDlcPhaseState(state, baseDir);
    expect(filePath.endsWith('aidlc-phase-state.json')).toBe(true);

    const loaded = loadAiDlcPhaseState('MSN-AIDLC-5', baseDir);
    expect(loaded?.phase).toBe('execution');
    expect(loaded?.execution_result?.summary).toBe('done');
    expect(loadAiDlcPhaseState('MSN-NONE', baseDir)).toBeNull();
  });
});
