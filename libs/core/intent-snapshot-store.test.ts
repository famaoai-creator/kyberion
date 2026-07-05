import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  latestSnapshot,
  listSnapshots,
  mapStageToLoopPhase,
  recordApprovedIntentScopeChange,
} from './intent-snapshot-store.js';

vi.mock('./path-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./path-resolver.js')>('./path-resolver.js');
  return {
    ...actual,
    missionEvidenceDir: vi.fn(),
  };
});

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: () => ({ allowed: true }),
  validateReadPermission: () => ({ allowed: true }),
  detectTier: () => 'public',
}));

vi.mock('./policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true, action: 'allow' }) },
}));

import { missionEvidenceDir } from './path-resolver.js';

describe('intent-snapshot-store', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-snap-'));
    (missionEvidenceDir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('appends a snapshot and returns no delta on first emission', () => {
    const result = emitIntentSnapshot({
      missionId: 'MSN-1',
      stage: 'intake',
      source: 'user_prompt',
      intent: { goal: 'prepare quarterly report' },
    });
    expect(result.snapshot.mission_id).toBe('MSN-1');
    expect(result.snapshot.kind).toBe('origin');
    expect(result.delta).toBeNull();
    expect(listSnapshots('MSN-1')).toHaveLength(1);
  });

  it('computes a delta once two snapshots exist', () => {
    emitIntentSnapshot({
      missionId: 'MSN-2',
      stage: 'intake',
      source: 'user_prompt',
      intent: { goal: 'prepare quarterly report' },
    });
    const { delta } = emitIntentSnapshot({
      missionId: 'MSN-2',
      stage: 'planning',
      source: 'worker_transition',
      intent: { goal: 'prepare annual strategic deck' },
    });
    expect(delta).not.toBeNull();
    expect(delta?.changes.goal_changed).toBe(true);
    expect(delta?.drift_score).toBeGreaterThan(0);
  });

  it('compares the origin snapshot to the latest snapshot when evaluating drift', () => {
    emitIntentSnapshot({
      missionId: 'MSN-2A',
      stage: 'intake',
      source: 'user_prompt',
      intent: { goal: 'prepare quarterly report' },
    });
    emitIntentSnapshot({
      missionId: 'MSN-2A',
      stage: 'planning',
      source: 'worker_transition',
      intent: { goal: 'prepare quarterly report', constraints: ['by Friday'] },
    });
    emitIntentSnapshot({
      missionId: 'MSN-2A',
      stage: 'execution',
      source: 'worker_transition',
      intent: { goal: 'rewrite marketing website', constraints: ['by Friday'] },
    });
    const gate = evaluateIntentDriftGate('MSN-2A');
    expect(gate.passed).toBe(false);
    expect(gate.verdict).toBe('blocking');
  });

  it('returns the most recent snapshot from latestSnapshot', () => {
    emitIntentSnapshot({
      missionId: 'MSN-3',
      stage: 'intake',
      source: 'user_prompt',
      intent: { goal: 'alpha' },
    });
    emitIntentSnapshot({
      missionId: 'MSN-3',
      stage: 'execution',
      source: 'worker_transition',
      intent: { goal: 'beta' },
    });
    expect(latestSnapshot('MSN-3')?.intent.goal).toBe('beta');
  });

  describe('evaluateIntentDriftGate', () => {
    it('passes by default when no snapshots exist', () => {
      const gate = evaluateIntentDriftGate('MSN-EMPTY');
      expect(gate.passed).toBe(true);
      expect(gate.verdict).toBe('no_history');
    });

    it('passes when drift is below blocking', () => {
      emitIntentSnapshot({
        missionId: 'MSN-4',
        stage: 'intake',
        source: 'user_prompt',
        intent: { goal: 'ship release 1.0' },
      });
      emitIntentSnapshot({
        missionId: 'MSN-4',
        stage: 'planning',
        source: 'worker_transition',
        intent: { goal: 'ship release 1.0', constraints: ['by Friday'] },
      });
      const gate = evaluateIntentDriftGate('MSN-4');
      expect(gate.passed).toBe(true);
      expect(['none', 'minor', 'significant']).toContain(gate.verdict);
    });

    it('blocks when drift verdict is blocking', () => {
      emitIntentSnapshot({
        missionId: 'MSN-5',
        stage: 'intake',
        source: 'user_prompt',
        intent: { goal: 'refactor payment adapter' },
      });
      emitIntentSnapshot({
        missionId: 'MSN-5',
        stage: 'execution',
        source: 'worker_transition',
        intent: { goal: 'write marketing blog post' },
      });
      const gate = evaluateIntentDriftGate('MSN-5');
      expect(gate.passed).toBe(false);
      expect(gate.verdict).toBe('blocking');
    });

    it('rebaselines from the latest approved origin scope change', () => {
      emitIntentSnapshot({
        missionId: 'MSN-6',
        stage: 'intake',
        source: 'user_prompt',
        intent: { goal: 'prepare quarterly report' },
      });
      emitIntentSnapshot({
        missionId: 'MSN-6',
        stage: 'execution',
        source: 'worker_transition',
        intent: { goal: 'rewrite marketing website' },
      });

      const before = evaluateIntentDriftGate('MSN-6');
      expect(before.passed).toBe(false);
      expect(before.verdict).toBe('blocking');

      const change = recordApprovedIntentScopeChange({
        missionId: 'MSN-6',
        approvedBy: 'owner-1',
        reason: 'Approved scope expansion to reflect the revised website deliverable.',
        intent: {
          goal: 'rewrite marketing website',
          deliverables: ['website copy', 'launch checklist'],
        },
      });
      expect(change.change.previous_origin_snapshot_id).not.toBeNull();

      emitIntentSnapshot({
        missionId: 'MSN-6',
        stage: 'execution',
        source: 'worker_transition',
        intent: {
          goal: 'rewrite marketing website',
          deliverables: ['website copy', 'launch checklist', 'handoff note'],
        },
      });

      const after = evaluateIntentDriftGate('MSN-6');
      expect(after.passed).toBe(true);
      expect(after.verdict).not.toBe('blocking');

      const originCount = listSnapshots('MSN-6').filter(
        (snapshot) => snapshot.kind === 'origin'
      ).length;
      expect(originCount).toBe(2);
    });
  });

  describe('mapStageToLoopPhase', () => {
    it('maps Kyberion stages onto intent-loop phases', () => {
      expect(mapStageToLoopPhase('intake')).toBe('receive');
      expect(mapStageToLoopPhase('classification')).toBe('clarify');
      expect(mapStageToLoopPhase('planning')).toBe('preserve');
      expect(mapStageToLoopPhase('execution')).toBe('execute');
      expect(mapStageToLoopPhase('verification')).toBe('verify');
      expect(mapStageToLoopPhase('delivery')).toBe('learn');
    });

    it('passes unknown stages through unchanged', () => {
      expect(mapStageToLoopPhase('custom-stage')).toBe('custom-stage');
    });
  });
});
