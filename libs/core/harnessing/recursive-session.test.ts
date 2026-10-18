import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { runRecursiveSession, resumeRecursiveSession } from './recursive-session.js';
import { copyTreeHashed, manifestsEqual, runProbe, treeManifest } from './probe-runner.js';
import { lookupLessons } from './experience-library.js';

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

describe('experience write-back (experienceSink)', () => {
  it('emits a per-round experience on a landed adoption and persists it', async () => {
    const lib = path.join(ROOT, 'lib-rec');
    safeRmSync(lib);
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-exp',
      runRoot: path.join(ROOT, 'run-exp'),
      candidates: [
        { label: 'win', overlayDir: overlay('winexp', { pass_marker: '1' }) },
        { label: 'none', overlayDir: overlay('noneexp', {}) },
      ],
      rounds: 2,
      metrics: [{ key: 'produced_files', direction: 'higher' }],
      work_shape: 'shape-rec',
      experienceSink: { root: lib, domain: 'dom' },
    });
    // r1 auto_advance lands; r2 keep_base emits nothing.
    expect(r.rounds[0].experience).toBeDefined();
    expect(r.rounds[0].experience!.lesson).toContain("'win'");
    expect(r.rounds[0].experience!.evidence).toContain("adopted 'r1:win'");
    expect(r.rounds[0].experience!.evidence).toContain('report.json');
    expect(r.rounds[1].experience).toBeUndefined();
    const seen = lookupLessons({ libraryRoot: lib, domain: 'dom' });
    expect(seen).toHaveLength(1);
    expect(seen[0].cue).toBe('shape-rec');
  });

  it('emits a decided-not-materialized experience on auto_advance_final', async () => {
    const lib = path.join(ROOT, 'lib-final');
    safeRmSync(lib);
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-exp-final',
      runRoot: path.join(ROOT, 'run-exp-final'),
      candidates: [{ label: 'win', overlayDir: overlay('winfin', { pass_marker: '1' }) }],
      rounds: 1,
      experienceSink: { root: lib, domain: 'dom' },
    });
    expect(r.halted_by).toBe('auto_advance_final');
    expect(r.rounds[0].experience).toBeDefined();
    expect(r.rounds[0].experience!.evidence).toContain('not materialized');
    // The final-round winner still qualifies — the contrast was decisive.
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toHaveLength(1);
  });

  it('emits no experience and persists nothing on human_gate', async () => {
    const lib = path.join(ROOT, 'lib-hgate');
    safeRmSync(lib);
    const r = await runRecursiveSession({
      ...base(),
      session_id: 'rec-exp-gate',
      runRoot: path.join(ROOT, 'run-exp-gate'),
      candidates: [
        { label: 'a', overlayDir: overlay('ga', { pass_marker: '1' }) },
        { label: 'b', overlayDir: overlay('gb', { pass_marker: '1' }) },
      ],
      rounds: 3,
      experienceSink: { root: lib, domain: 'dom' },
    });
    expect(r.halted_by).toBe('human_gate');
    expect(r.rounds[0].experience).toBeUndefined();
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toEqual([]);
  });

  it('persists nothing when adoption fails (materialization_error)', async () => {
    const lib = path.join(ROOT, 'lib-materr');
    safeRmSync(lib);
    const scenDir = path.join(ROOT, 'scenario-tamper2');
    const ovDir = path.join(ROOT, 'ov', 'win-tamper2');
    safeMkdir(scenDir, { recursive: true });
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\ntest -f iam_win && echo TAMPER > "../.snapshots/win/pass_marker"\n`
    );
    overlay('win-tamper2', { pass_marker: 'ORIG', iam_win: '1' });
    const r = await runRecursiveSession({
      session_id: 'rec-exp-materr',
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      runRoot: path.join(ROOT, 'run-exp-materr'),
      candidates: [
        { label: 'win', overlayDir: ovDir },
        { label: 'none', overlayDir: overlay('none-t2', {}) },
      ],
      rounds: 2,
      experienceSink: { root: lib, domain: 'dom' },
    });
    expect(r.halted_by).toBe('materialization_error');
    expect(r.rounds[0].experience).toBeUndefined();
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toEqual([]);
  });
});

describe('resumeRecursiveSession (human_gate resume)', () => {
  /** Halts at round 1: base fails, two candidates deliver -> human_gate. */
  const haltSpec = (runRoot: string, ovA: string, ovB: string) => ({
    ...base(),
    session_id: `halt-${path.basename(runRoot)}`,
    runRoot,
    candidates: [
      { label: 'a', overlayDir: ovA },
      { label: 'b', overlayDir: ovB },
    ],
    rounds: 3,
    metrics: [{ key: 'produced_files', direction: 'higher' as const }],
  });

  it('adopts the picked candidate verified bytes, then runs remaining rounds', async () => {
    const scenDir = scenario();
    const ovA = overlay('res-a', { pass_marker: '1', tag_a: 'A' });
    const ovB = overlay('res-b', { pass_marker: '1', tag_b: 'B' });
    const halted = await runRecursiveSession(
      haltSpec(path.join(ROOT, 'run-resume-halt'), ovA, ovB)
    );
    expect(halted.halted_by).toBe('human_gate');
    // Mutate the LIVE overlay after the halt — the resume must adopt the
    // probed snapshot bytes ('A'), never the post-halt mutation.
    safeWriteFile(path.join(ovA, 'tag_a'), 'MUTATED');
    const resumed = await resumeRecursiveSession(
      {
        ...haltSpec(path.join(ROOT, 'run-resumed'), ovA, ovB),
        session_id: 'rec-resumed',
        scenarioDir: scenDir,
      },
      { fromReport: halted.report_path, adopt: 'a' }
    );
    // The resume adoption is labelled distinctly — never 'r1:a' auto_advance.
    expect(resumed.adopted_overlays[0]).toBe('resume:r1:a');
    expect(resumed.resume).toEqual({
      from: halted.report_path,
      adopt: 'a',
      halted_round: 1,
    });
    // Materialized round-2 base carries the PROBED bytes, not 'MUTATED'.
    const adoptedTag = path.join(ROOT, 'run-resumed', 'bases', 'round-2', 'tag_a');
    expect(String(safeReadFile(adoptedTag)).trim()).toBe('A');
    // Remaining rounds ran with continuing round numbers; the adopted base
    // delivers now, so round 2 resolves keep_base (nothing dominates it).
    expect(resumed.rounds.map((x) => x.round)).toEqual([2]);
    expect(resumed.halted_by).toBe('keep_base');
    const report = JSON.parse(String(safeReadFile(resumed.report_path)));
    expect(report.resumed_from).toBe(halted.report_path);
    expect(report.resumed_adopt).toBe('a');
    expect(report.adopted_via).toBe('human_gate_resume');
    expect(report.resumed_after_round).toBe(1);
    expect(report.declared_rounds).toBe(2); // remaining budget, honestly declared
  });

  it('refuses with materialization_error when the adopted snapshot was tampered', async () => {
    const ovA = overlay('tamp-a', { pass_marker: '1', tag_a: 'A' });
    const ovB = overlay('tamp-b', { pass_marker: '1', tag_b: 'B' });
    const halted = await runRecursiveSession(haltSpec(path.join(ROOT, 'run-tamp-halt'), ovA, ovB));
    expect(halted.halted_by).toBe('human_gate');
    // Tamper the SNAPSHOT (not the live overlay) — manifest verify must fail.
    const snap = halted.rounds[0].outcomes.find((o) => o.label === 'a')!.staged_snapshot!;
    safeWriteFile(path.join(snap, 'tag_a'), 'TAMPER');
    const r = await resumeRecursiveSession(
      {
        ...haltSpec(path.join(ROOT, 'run-tamp-resumed'), ovA, ovB),
        session_id: 'rec-tamp-resumed',
      },
      { fromReport: halted.report_path, adopt: 'a' }
    );
    expect(r.halted_by).toBe('materialization_error');
    expect(r.rounds).toHaveLength(0);
    expect(r.adopted_overlays).toEqual([]);
    const report = JSON.parse(String(safeReadFile(r.report_path)));
    expect(report.materialization_error).toMatch(/drifted|materialization failed/);
  });

  it('refuses a missing or non-delivered adopt label — never auto-picks', async () => {
    const ovA = overlay('np-a', { pass_marker: '1' });
    const ovB = overlay('np-b', { pass_marker: '1' });
    const ovC = overlay('np-c', { tag_c: 'C' }); // no pass_marker -> not delivered
    const halted = await runRecursiveSession({
      ...base(),
      session_id: 'halt-np',
      runRoot: path.join(ROOT, 'run-np-halt'),
      candidates: [
        { label: 'a', overlayDir: ovA },
        { label: 'b', overlayDir: ovB },
        { label: 'c', overlayDir: ovC },
      ],
      rounds: 3,
    });
    expect(halted.halted_by).toBe('human_gate');
    const spec = {
      ...base(),
      session_id: 'rec-np',
      runRoot: path.join(ROOT, 'run-np-resumed'),
      candidates: [
        { label: 'a', overlayDir: ovA },
        { label: 'b', overlayDir: ovB },
        { label: 'c', overlayDir: ovC },
      ],
      rounds: 3,
    };
    await expect(
      resumeRecursiveSession(spec, { fromReport: halted.report_path, adopt: 'zzz' })
    ).rejects.toThrow(/no candidate/);
    await expect(
      resumeRecursiveSession(spec, { fromReport: halted.report_path, adopt: 'c' })
    ).rejects.toThrow(/did not deliver/);
  });

  it('rejects resuming a report that did not halt on human_gate', async () => {
    const done = await runRecursiveSession({
      ...base(),
      session_id: 'halt-none',
      runRoot: path.join(ROOT, 'run-done'),
      candidates: [{ label: 'w', overlayDir: overlay('done-w', { pass_marker: '1' }) }],
      rounds: 2,
      metrics: [{ key: 'produced_files', direction: 'higher' }],
    });
    expect(done.halted_by).not.toBe('human_gate');
    await expect(
      resumeRecursiveSession(
        {
          ...base(),
          session_id: 'rec-nonresume',
          runRoot: path.join(ROOT, 'run-nonresume'),
          candidates: [{ label: 'w', overlayDir: overlay('done-w', { pass_marker: '1' }) }],
          rounds: 2,
        },
        { fromReport: done.report_path, adopt: 'w' }
      )
    ).rejects.toThrow(/human_gate/);
  });

  it('rejects a runRoot equal to the halted session root (report is evidence)', async () => {
    const ovA = overlay('ow-a', { pass_marker: '1' });
    const ovB = overlay('ow-b', { pass_marker: '1' });
    const runRoot = path.join(ROOT, 'run-overwrite');
    const halted = await runRecursiveSession(haltSpec(runRoot, ovA, ovB));
    expect(halted.halted_by).toBe('human_gate');
    await expect(
      resumeRecursiveSession(
        { ...haltSpec(runRoot, ovA, ovB), session_id: 'rec-overwrite' },
        { fromReport: halted.report_path, adopt: 'a' }
      )
    ).rejects.toThrow(/runRoot must differ/);
  });
});
