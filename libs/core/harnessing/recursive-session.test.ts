import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeWriteFile } from '../secure-io.js';
import { runRecursiveSession } from './recursive-session.js';
import { runProbe } from './probe-runner.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-recursive-test');

function scenario(): string {
  const dir = path.join(ROOT, 'scenario');
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'run.sh'), '#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\n');
  return dir;
}
function overlay(label: string, files: Record<string, string>): string {
  const dir = path.join(ROOT, 'ov', label);
  for (const [rel, c] of Object.entries(files)) {
    const t = path.join(dir, rel);
    safeMkdir(path.dirname(t), { recursive: true });
    safeWriteFile(t, c);
  }
  return dir;
}
const base = () => ({
  scenarioDir: scenario(),
  command: ['sh', 'run.sh'],
  expectOutputs: ['out.txt'],
});

describe('runRecursiveSession', () => {
  it('auto_advance in round 1 materializes the winner into the round-2 base', async () => {
    // ov1 provides pass_marker -> wins r1; r2's base now HAS pass_marker,
    // so base delivers and ov2 (empty overlay) can't dominate -> keep_base.
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-mat',
      runRoot: path.join(ROOT, 'run-mat'),
      candidates: [
        { label: 'win', overlayDir: overlay('win', { pass_marker: '1' }) },
        { label: 'none', overlayDir: overlay('none', {}) },
      ],
      rounds: 2,
      // produced_files ties deterministically in round 2 (every run creates
      // exactly out.txt), so nobody dominates the delivering base -> keep_base.
      metrics: [{ key: 'produced_files', direction: 'higher' }],
    });
    expect(r.rounds).toHaveLength(2);
    expect(r.adopted_overlays).toEqual(['r1:win']);
    expect(r.halted_by).toBe('keep_base');
    // round-2 base delivered (winner applied) — candidates no longer win.
    const r2Base = r.rounds[1].decision.decisive_evidence.find((e) => e.label === 'base')!;
    expect(r2Base.delivered).toBe(true);
  });
  it('human_gate halts the loop without progressing', async () => {
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-halt',
      runRoot: path.join(ROOT, 'run-halt'),
      candidates: [
        { label: 'a', overlayDir: overlay('a', { pass_marker: '1' }) },
        { label: 'b', overlayDir: overlay('b', { pass_marker: '1' }) },
      ],
      rounds: 3,
      selection: 'blind',
      selector: () => 'A',
    });
    expect(r.rounds).toHaveLength(1);
    expect(r.halted_by).toBe('human_gate');
    expect(r.rounds[0].selection).not.toBeNull();
  });
  it('reports budget identity expected-vs-actual', async () => {
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-budget',
      runRoot: path.join(ROOT, 'run-budget'),
      candidates: [{ label: 'w', overlayDir: overlay('w2', { pass_marker: '1' }) }],
      rounds: 2,
    });
    expect(r.budget.expected_probes).toBe(4); // 2 rounds x (1 base + 1 cand)
    expect(r.budget.actual_probes).toBe(4);
    expect(r.budget.status).toBe('ok');
  });
  it('rejects invalid candidate labels up front', async () => {
    await expect(
      runRecursiveSession({
        ...base(),
        session_id: 'rec-bad',
        runRoot: path.join(ROOT, 'run-bad'),
        candidates: [{ label: 'base', overlayDir: overlay('bad', {}) }],
        rounds: 1,
      })
    ).rejects.toThrow(/reserved|invalid/i);
  });
});

describe('honesty + edge cases', () => {
  it('custom selector labels method heuristic_blind, never llm', async () => {
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-method',
      runRoot: path.join(ROOT, 'run-method'),
      candidates: [
        { label: 'a', overlayDir: overlay('m1', { pass_marker: '1' }) },
        { label: 'b', overlayDir: overlay('m2', { pass_marker: '1' }) },
      ],
      rounds: 1,
      selection: 'blind',
      selector: () => 'A',
    });
    expect(r.rounds[0].selection?.method).toBe('heuristic_blind');
  });
  it('throws when propose lacks a surface', async () => {
    await expect(
      runRecursiveSession({
        ...base(),
        session_id: 'rec-nosurface',
        runRoot: path.join(ROOT, 'run-nosurface'),
        propose: { brief: 'x', count: 1 },
        rounds: 1,
      })
    ).rejects.toThrow(/requires a surface/);
  });
  it('reports propose_meta when a propose stage ran', async () => {
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-meta',
      runRoot: path.join(ROOT, 'run-meta'),
      propose: { brief: 'x', count: 1 },
      surface: { allowed_paths: ['config/'] },
      candidates: [{ label: 'c1', overlayDir: overlay('pm', { pass_marker: '1' }) }],
      rounds: 1,
    });
    expect(r.rounds[0].propose_meta).toBeDefined();
    // No reasoning backend is registered in tests — the stub must be
    // reported honestly, not as a real backend.
    expect(r.rounds[0].propose_meta!.backend_used).toBe(false);
    expect(r.rounds[0].propose_meta!.error).toMatch(/degraded/);
  });
});

describe('probed-bytes adoption (R7-04)', () => {
  it('materializes the winner from the staged snapshot, not the live overlayDir', async () => {
    // The scenario command itself MUTATES the live overlay during the round-1
    // probe (writes into the overlay dir via absolute path). Materialization
    // must still adopt the bytes that were actually probed ('ORIG'), never
    // the post-probe mutation ('MUT').
    const scenDir = path.join(ROOT, 'scenario-mut');
    const ovDir = path.join(ROOT, 'ov', 'win-mut');
    const target = path.join(ovDir, 'pass_marker');
    safeMkdir(scenDir, { recursive: true });
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      // Mutate only when the run contains the win overlay's iam_win marker —
      // otherwise the base probe would corrupt the overlay before 'win' is
      // even staged, which is a different bug than the one under test.
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && echo MUT > "${target}"\n`
    );
    overlay('win-mut', { pass_marker: 'ORIG', iam_win: '1' });
    const runRoot = path.join(ROOT, 'run-mut');
    const r = await runRecursiveSession({
      session_id: 'rec-mut',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot,
      candidates: [
        { label: 'win', overlayDir: ovDir },
        { label: 'none', overlayDir: overlay('none-mut', {}) },
      ],
      rounds: 2,
      metrics: [{ key: 'produced_files', direction: 'higher' }],
    });
    expect(r.adopted_overlays).toEqual(['r1:win']);
    // The live overlay was mutated mid-probe — proof the window existed.
    expect(String(safeReadFile(target)).trim()).toBe('MUT');
    // The adopted next base carries the PROBED bytes, not the live ones.
    const nextBaseMarker = path.join(runRoot, 'bases', 'round-2', 'pass_marker');
    expect(String(safeReadFile(nextBaseMarker)).trim()).toBe('ORIG');
    // The snapshot itself records the staged bytes.
    const snap = r.rounds[0].outcomes.find((o) => o.label === 'win')!.staged_snapshot!;
    expect(String(safeReadFile(path.join(snap, 'pass_marker'))).trim()).toBe('ORIG');
  });
  it('runProbe exposes staged_snapshot and reruns reset it', async () => {
    const scenDir = scenario();
    const ovDir = overlay('snap', { pass_marker: 'v1' });
    const runRoot = path.join(ROOT, 'run-snap');
    const outcome = runProbe({
      label: 'c',
      scenarioDir: scenDir,
      overlayDir: ovDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot,
    });
    expect(outcome.staged_snapshot).toBeDefined();
    expect(String(safeReadFile(path.join(outcome.staged_snapshot!, 'pass_marker')))).toBe('v1');
    // Mutate the live overlay and re-probe — snapshot must reset, not merge.
    safeWriteFile(path.join(ovDir, 'pass_marker'), 'v2');
    safeWriteFile(path.join(ovDir, 'extra.txt'), 'new');
    const again = runProbe({
      label: 'c',
      scenarioDir: scenDir,
      overlayDir: ovDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot,
    });
    expect(String(safeReadFile(path.join(again.staged_snapshot!, 'pass_marker')))).toBe('v2');
    expect(String(safeReadFile(path.join(again.staged_snapshot!, 'extra.txt')))).toBe('new');
  });
});
