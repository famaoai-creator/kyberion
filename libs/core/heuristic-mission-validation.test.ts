import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return { ...actual, rootResolve: vi.fn() };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'confidential',
}));

vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('./knowledge/memory-promotion-queue.js', async () => {
  const actual = await vi.importActual<typeof import('./knowledge/memory-promotion-queue.js')>(
    './knowledge/memory-promotion-queue.js'
  );
  return { ...actual, enqueueMemoryPromotionCandidate: enqueue };
});

import { pathResolver, rootResolve } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  deriveMissionOutcome,
  readHeuristic,
  validateMissionHeuristics,
} from './heuristic-feedback.js';

describe('heuristic mission validation', () => {
  let tmpDir = '';
  const mockResolve = rootResolve as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = pathResolver.sharedTmp(`heuristic-mission-${process.pid}`);
    safeRmSync(tmpDir, { recursive: true, force: true });
    safeMkdir(tmpDir, { recursive: true });
    mockResolve.mockImplementation((rel: string) => path.join(tmpDir, rel));
    enqueue.mockReset();
  });

  afterEach(() => {
    safeRmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(id: string, extra: Record<string, unknown> = {}) {
    const dir = path.join(tmpDir, 'knowledge/confidential/heuristics');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        captured_at: '2026-04-20T00:00:00Z',
        decision: 'pick option A',
        anchor: 'option A',
        analogy: 'last-year-acquisition',
        ...extra,
      })
    );
  }

  describe('deriveMissionOutcome', () => {
    it('is success only when every item is done and no finish gate failed', () => {
      expect(
        deriveMissionOutcome({
          missionId: 'MSN-1',
          itemStatuses: ['done', 'completed', 'accepted'],
          finishGateFailures: 0,
        })
      ).toMatchObject({ result: 'success', metric_score: 1 });
      expect(
        deriveMissionOutcome({ missionId: 'MSN-1', itemStatuses: ['done'], finishGateFailures: 1 })
      ).toMatchObject({ result: 'partial' });
    });

    it('is failure when nothing finished and partial in between', () => {
      expect(
        deriveMissionOutcome({
          missionId: 'MSN-1',
          itemStatuses: ['blocked', 'failed'],
          finishGateFailures: 0,
        })
      ).toMatchObject({ result: 'failure', metric_score: 0 });
      expect(
        deriveMissionOutcome({
          missionId: 'MSN-1',
          itemStatuses: ['done', 'blocked'],
          finishGateFailures: 0,
        })
      ).toMatchObject({ result: 'partial', metric_score: 0.5 });
    });

    it('has no outcome for a mission without work items', () => {
      expect(
        deriveMissionOutcome({ missionId: 'MSN-1', itemStatuses: [], finishGateFailures: 0 })
      ).toBeNull();
    });
  });

  describe('validateMissionHeuristics', () => {
    it('scores only this mission’s unscored heuristics and queues the ones that held up', () => {
      seed('H-win', { mission_id: 'msn-1' });
      seed('H-other', { mission_id: 'MSN-2' });
      seed('H-free');
      const outcome = deriveMissionOutcome({
        missionId: 'MSN-1',
        itemStatuses: ['done', 'done'],
        finishGateFailures: 0,
      })!;
      const result = validateMissionHeuristics(outcome);
      expect(result).toEqual({ validated: ['H-win'], queued: ['H-win'], errors: [] });
      expect(readHeuristic('H-win')?.validation).toMatchObject({
        outcome_result: 'success',
        validity_score: 1,
      });
      expect(readHeuristic('H-other')?.validation).toBeUndefined();
      expect(readHeuristic('H-free')?.validation).toBeUndefined();
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][0]).toMatchObject({
        source_ref: 'heuristic:H-win',
        ratification_required: true,
      });
    });

    it('stamps a poor outcome but does not offer it as memory', () => {
      seed('H-lose', { mission_id: 'MSN-1' });
      const outcome = deriveMissionOutcome({
        missionId: 'MSN-1',
        itemStatuses: ['blocked'],
        finishGateFailures: 0,
      })!;
      expect(validateMissionHeuristics(outcome)).toEqual({
        validated: ['H-lose'],
        queued: [],
        errors: [],
      });
      expect(readHeuristic('H-lose')?.validation?.validity_score).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('leaves an already-validated heuristic alone when the mission is finished again', () => {
      seed('H-win', { mission_id: 'MSN-1' });
      const outcome = deriveMissionOutcome({
        missionId: 'MSN-1',
        itemStatuses: ['done'],
        finishGateFailures: 0,
      })!;
      validateMissionHeuristics(outcome);
      enqueue.mockClear();
      expect(validateMissionHeuristics(outcome)).toEqual({ validated: [], queued: [], errors: [] });
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
