import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { runRecursiveSession } from './recursive-session.js';

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
