import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { runContrastiveSession } from './contrastive-session.js';
import { lookupLessons } from './experience-library.js';

const ROOT = path.join(process.cwd(), 'active/shared/tmp/harnessing-session-test');

function scenario(): string {
  const dir = path.join(ROOT, 'scenario');
  safeMkdir(dir, { recursive: true });
  const sh = path.join(dir, 'run.sh');
  safeWriteFile(sh, '#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\n');
  return dir;
}

function overlay(label: string, files: Record<string, string>): string {
  const dir = path.join(ROOT, 'ov', label);
  for (const [rel, content] of Object.entries(files)) {
    const t = path.join(dir, rel);
    safeMkdir(path.dirname(t), { recursive: true });
    safeWriteFile(t, content);
  }
  return dir;
}

const sessionSpec = {
  scenarioDir: scenario(),
  command: ['sh', 'run.sh'],
  expectOutputs: ['out.txt'],
};

describe('runContrastiveSession', () => {
  it('fires blind selection only on human_gate', async () => {
    const r = await runContrastiveSession({
      ...sessionSpec,
      session_id: 'sess-blind',
      runRoot: path.join(ROOT, 'runs-blind'),
      candidates: [
        { label: 'a', overlayDir: overlay('a', { pass_marker: '1' }) },
        { label: 'b', overlayDir: overlay('b', { pass_marker: '1' }) },
      ],
      selection: 'blind',
      seed: 7,
      selector: () => 'A',
    });
    // base fails; two candidates delivered -> human_gate + recommendation.
    expect(r.decision.decision).toBe('human_gate');
    expect(r.selection).not.toBeNull();
    expect(r.decision.auto_advance_allowed).toBe(false);
  });

  it('does not produce a selection on auto_advance', async () => {
    const r = await runContrastiveSession({
      ...sessionSpec,
      session_id: 'sess-advance',
      runRoot: path.join(ROOT, 'runs-advance'),
      candidates: [{ label: 'a', overlayDir: overlay('a2', { pass_marker: '1' }) }],
      selection: 'blind',
      selector: () => 'A',
    });
    expect(r.decision.decision).toBe('auto_advance');
    expect(r.selection).toBeNull();
    expect(r.experience).not.toBeNull();
  });

  it('rejects a supplied/proposed label collision before any probe runs', async () => {
    await expect(
      runContrastiveSession({
        ...sessionSpec,
        session_id: 'sess-collide',
        runRoot: path.join(ROOT, 'runs-collide'),
        candidates: [{ label: 'llm1', overlayDir: overlay('llm1c', {}) }],
        propose: { brief: 'x', count: 1 },
        surface: { allowed_paths: ['config/'] },
      })
    ).rejects.toThrow(/duplicate candidate labels/);
    // Nothing was probed: no run dirs were created.
    expect(safeExistsSync(path.join(ROOT, 'runs-collide', 'base'))).toBe(false);
  });

  it('declines with structured rejections when every overlay is off-surface', async () => {
    const r = await runContrastiveSession({
      ...sessionSpec,
      session_id: 'sess-reject',
      runRoot: path.join(ROOT, 'runs-reject'),
      candidates: [{ label: 'off', overlayDir: overlay('offc', { 'evil/hack.sh': 'x' }) }],
      surface: { allowed_paths: ['config/'] },
    });
    expect(r.decision.decision).toBe('decline');
    expect(r.rejected_overlays.length).toBeGreaterThan(0);
    expect(r.base.ok).toBe(false); // base probe skipped — nothing to contrast
  });
});

describe('experience write-back (experienceSink)', () => {
  const sinkSession = (
    sessionId: string,
    runRoot: string,
    lib: string,
    candidates: Array<{ label: string; overlayDir: string }>
  ) =>
    runContrastiveSession({
      ...sessionSpec,
      session_id: sessionId,
      runRoot,
      candidates,
      work_shape: 'shape-x',
      experienceSink: { root: lib, domain: 'dom' },
    });

  it('persists a qualifying auto_advance lesson to the library', async () => {
    const lib = path.join(ROOT, 'lib-advance');
    safeRmSync(lib);
    const r = await sinkSession('sess-sink', path.join(ROOT, 'runs-sink'), lib, [
      { label: 'a', overlayDir: overlay('sink-a', { pass_marker: '1' }) },
    ]);
    expect(r.decision.decision).toBe('auto_advance');
    expect(r.experience_writeback).toBe('persisted');
    const seen = lookupLessons({ libraryRoot: lib, domain: 'dom' });
    expect(seen).toHaveLength(1);
    expect(seen[0].cue).toBe('shape-x');
    expect(seen[0].lesson).toContain("'a'");
    // Evidence must cite the report path honestly.
    expect(seen[0].evidence).toContain('report.json');
    expect(seen[0].evidence).toContain("adopted 'a'");
  });

  it('persists nothing on human_gate or decline', async () => {
    const lib = path.join(ROOT, 'lib-gated');
    safeRmSync(lib);
    const gated = await sinkSession('sess-sink-gate', path.join(ROOT, 'runs-sink-gate'), lib, [
      { label: 'a', overlayDir: overlay('gate-a', { pass_marker: '1' }) },
      { label: 'b', overlayDir: overlay('gate-b', { pass_marker: '1' }) },
    ]);
    expect(gated.decision.decision).toBe('human_gate');
    expect(gated.experience_writeback).toBe('rejected');
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toEqual([]);
  });

  it('rejects write-back when the base drifted mid-session', async () => {
    const lib = path.join(ROOT, 'lib-drifted');
    safeRmSync(lib);
    const scenDir = path.join(ROOT, 'scenario-sinkdrift');
    safeMkdir(scenDir, { recursive: true });
    // The scenario mutates its own input dir — the base manifest must drift.
    safeWriteFile(
      path.join(scenDir, 'run.sh'),
      `#!/bin/sh\ntest -f pass_marker && echo ok > out.txt\necho drift >> "${path.join(scenDir, 'drift.txt')}"\n`
    );
    const r = await runContrastiveSession({
      scenarioDir: scenDir,
      command: ['sh', 'run.sh'],
      expectOutputs: ['out.txt'],
      session_id: 'sess-sink-drift',
      runRoot: path.join(ROOT, 'runs-sink-drift'),
      candidates: [{ label: 'a', overlayDir: overlay('drift-a', { pass_marker: '1' }) }],
      experienceSink: { root: lib, domain: 'dom' },
    });
    expect(r.decision.decision).toBe('auto_advance');
    expect(r.experience_writeback).toBe('rejected');
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toEqual([]);
  });

  it('dedupes an identical cue+lesson across sessions', async () => {
    const lib = path.join(ROOT, 'lib-dedup');
    safeRmSync(lib);
    const ov = overlay('dedup-a', { pass_marker: '1' });
    const r1 = await sinkSession('sess-dedup-1', path.join(ROOT, 'runs-dedup-1'), lib, [
      { label: 'a', overlayDir: ov },
    ]);
    const r2 = await sinkSession('sess-dedup-2', path.join(ROOT, 'runs-dedup-2'), lib, [
      { label: 'a', overlayDir: ov },
    ]);
    expect(r1.experience_writeback).toBe('persisted');
    expect(r2.experience_writeback).toBe('duplicate');
    expect(lookupLessons({ libraryRoot: lib, domain: 'dom' })).toHaveLength(1);
  });
});
