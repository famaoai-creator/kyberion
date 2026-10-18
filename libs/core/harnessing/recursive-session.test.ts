import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeWriteFile } from '../secure-io.js';
import { runRecursiveSession } from './recursive-session.js';
import { copyTreeHashed, manifestsEqual, runProbe, treeManifest } from './probe-runner.js';

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

describe('snapshot integrity verification (R1 review)', () => {
  it('halts materialization_error when the scenario tampers the winner snapshot', async () => {
    // win's own probe writes into ../.snapshots/win post-staging — the
    // manifest must catch the drift at adoption time.
    const scenDir = path.join(ROOT, 'scenario-tamper');
    const ovDir = path.join(ROOT, 'ov', 'win-tamper');
    safeMkdir(scenDir, { recursive: true });
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && echo TAMPER > "../.snapshots/win/pass_marker"\n`
    );
    overlay('win-tamper', { pass_marker: 'ORIG', iam_win: '1' });
    const r = await runRecursiveSession({
      session_id: 'rec-tamper',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-tamper'),
      candidates: [
        { label: 'win', overlayDir: ovDir },
        { label: 'none', overlayDir: overlay('none-tamper', {}) },
      ],
      rounds: 2,
    });
    expect(r.halted_by).toBe('materialization_error');
    expect(r.adopted_overlays).toEqual([]);
    expect(r.rounds[0].rejected.some((x) => /snapshot drifted/.test(x.reason))).toBe(true);
  });
  it('halts materialization_error when the scenario mutates the base mid-round', async () => {
    const scenDir = path.join(ROOT, 'scenario-basedrift');
    const injected = path.join(scenDir, 'injected.txt');
    safeMkdir(scenDir, { recursive: true });
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && echo EVIL > "${injected}"\n`
    );
    const r = await runRecursiveSession({
      session_id: 'rec-basedrift',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-basedrift'),
      candidates: [
        {
          label: 'win',
          overlayDir: overlay('win-bd', { pass_marker: '1', iam_win: '1' }),
        },
        { label: 'none', overlayDir: overlay('none-bd', {}) },
      ],
      rounds: 2,
    });
    expect(r.halted_by).toBe('materialization_error');
    expect(r.adopted_overlays).toEqual([]);
    expect(r.rounds[0].rejected.some((x) => /base dir drifted/.test(x.reason))).toBe(true);
  });
  it('rejects a scenarioDir nested inside the snapshot tree', () => {
    const runRoot = path.join(ROOT, 'run-f2');
    const scenDir = path.join(runRoot, '.snapshots');
    safeMkdir(scenDir, { recursive: true });
    expect(() =>
      runProbe({
        label: 'c',
        scenarioDir: scenDir,
        overlayDir: overlay('f2', { a: '1' }),
        command: ['sh', 'x.sh'],
        runRoot,
      })
    ).toThrow(/nest inside each other/);
  });
});

describe('manifest edge cases (R2 review)', () => {
  it('halts materialization_error on binary tamper invisible to utf8 hashing', async () => {
    // 0x80 -> 0x81 would collide under utf8-string hashing (both decode to
    // U+FFFD). Byte-level hashing must see the drift.
    const scenDir = path.join(ROOT, 'scenario-bintamper');
    safeMkdir(scenDir, { recursive: true });
    const ovDir = path.join(ROOT, 'ov', 'win-bin');
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && printf '\\201' > "../.snapshots/win/payload.bin"\n`
    );
    safeWriteFile(path.join(ovDir, 'payload.bin'), Buffer.from([0x80]));
    safeWriteFile(path.join(ovDir, 'pass_marker'), '1');
    safeWriteFile(path.join(ovDir, 'iam_win'), '1');
    const r = await runRecursiveSession({
      session_id: 'rec-bintamper',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-bintamper'),
      candidates: [{ label: 'win', overlayDir: ovDir }],
      rounds: 2,
    });
    expect(r.halted_by).toBe('materialization_error');
    expect(r.adopted_overlays).toEqual([]);
    expect(r.rounds[0].rejected.some((x) => /snapshot drifted/.test(x.reason))).toBe(true);
  });
  it('halts materialization_error when the snapshot dir is swapped for a file', async () => {
    const scenDir = path.join(ROOT, 'scenario-dirswap');
    safeMkdir(scenDir, { recursive: true });
    const ovDir = path.join(ROOT, 'ov', 'win-swap');
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && rm -rf "../.snapshots/win" && echo x > "../.snapshots/win"\n`
    );
    safeWriteFile(path.join(ovDir, 'pass_marker'), '1');
    safeWriteFile(path.join(ovDir, 'iam_win'), '1');
    const r = await runRecursiveSession({
      session_id: 'rec-dirswap',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-dirswap'),
      candidates: [{ label: 'win', overlayDir: ovDir }],
      rounds: 2,
    });
    expect(r.halted_by).toBe('materialization_error');
    expect(r.rounds[0].rejected.some((x) => /manifest unreadable/.test(x.reason))).toBe(true);
  });
  it('runProbe refuses to execute when staged bytes carry a marker', () => {
    const scenDir = scenario();
    const ovDir = overlay('mark', {
      pass_marker: '1',
      'notes.txt': 'the rubric says expected_answer is 42',
    });
    const outcome = runProbe({
      label: 'm',
      scenarioDir: scenDir,
      overlayDir: ovDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-mark'),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.probe_refused).toBe('leak_marker');
    expect(outcome.error).toMatch(/leak marker:/);
    // The snapshot+manifest are still recorded honestly — the refusal is
    // evidence, and the staged bytes are auditable.
    expect(outcome.staged_snapshot).toBeDefined();
    expect(outcome.snapshot_manifest).toBeDefined();
  });
});

describe('integrity hardening (R3 review)', () => {
  it('copyTreeHashed manifests the bytes it copied, detectable post-copy', () => {
    const src = path.join(ROOT, 'hashed-src');
    const dst = path.join(ROOT, 'hashed-dst');
    safeWriteFile(path.join(src, 'a.txt'), 'alpha');
    safeWriteFile(path.join(src, 'sub', 'b.bin'), Buffer.from([0x80, 0x81]));
    const manifest = copyTreeHashed(src, dst);
    expect(Object.keys(manifest).sort()).toEqual(['a.txt', 'sub/b.bin']);
    // Same bytes as landed in dst — verifiable independently.
    expect(manifestsEqual(treeManifest(dst), manifest)).toBe(true);
    safeWriteFile(path.join(dst, 'a.txt'), 'changed');
    expect(manifestsEqual(treeManifest(dst), manifest)).toBe(false);
  });
  it('blind selection excludes a stage-refused outcome', async () => {
    // 'mark' passes the session-start scan CLEAN — the base probe injects a
    // marker into its live overlay before mark is staged, so the in-stage
    // snapshot scan refuses it. The probe_refused outcome reaches `outcomes`,
    // and the ok-filter must keep it out of the blind pool (3 rows if not).
    const scenDir = path.join(ROOT, 'scenario-pool');
    const markDir = path.join(ROOT, 'ov', 'pool-mark');
    safeWriteFile(path.join(scenDir, 'pass_marker'), '1');
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_mark || echo 'rubric eval_score' > "${path.join(markDir, 'n.txt')}"\n`
    );
    overlay('pool-mark', { benign: '1' });
    let poolSize = -1;
    const r = await runRecursiveSession({
      session_id: 'rec-pool',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-pool'),
      candidates: [
        { label: 'ok1', overlayDir: overlay('pool-ok', { extra: '1' }) },
        { label: 'mark', overlayDir: markDir },
      ],
      rounds: 1,
      selection: 'blind',
      selector: (rows) => {
        poolSize = rows.length;
        return 'A';
      },
    });
    expect(r.rounds[0].decision.decision).toBe('human_gate');
    expect(r.rounds[0].rejected.some((x) => /probe refused: leak marker/.test(x.reason))).toBe(
      true
    );
    expect(poolSize).toBe(2);
  });
});
