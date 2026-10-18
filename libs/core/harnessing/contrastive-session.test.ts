import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeWriteFile } from '../secure-io.js';
import { runContrastiveSession } from './contrastive-session.js';

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
