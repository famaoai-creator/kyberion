import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeReadFile, safeWriteFile } from '../secure-io.js';
import {
  recordAutonomyOutcome,
  actionAutonomyStats,
  applyAutonomyOverride,
  sweepAutonomyActionStates,
  AUTONOMY_OUTCOMES_PATH,
  AUTONOMY_OVERRIDES_PATH,
} from './autonomy-action-state.js';

const TEST_ROOT = 'active/shared/tmp/autonomy-action-state-tests';
const abs = (rel: string) => path.join(pathResolver.rootDir(), TEST_ROOT, rel);
const deps = { rootDir: path.join(pathResolver.rootDir(), TEST_ROOT) };

function seed(actionId: string, decisions: number, opts: { ok?: boolean } = {}) {
  for (let i = 0; i < decisions; i++) {
    recordAutonomyOutcome(
      { action_id: actionId, decision: 'approve', executed: opts.ok !== undefined, ok: opts.ok },
      deps
    );
  }
}

describe('autonomy-action-state', () => {
  beforeEach(() => safeRmSync(abs(''), { recursive: true, force: true }));

  it('records decisions and computes stats over the window', () => {
    seed('daemon_restart', 5);
    const s = actionAutonomyStats('daemon_restart', deps);
    expect(s.decisions).toBe(5);
    expect(s.incidents).toBe(0);
  });

  it('promotes approve→notify after enough incident-free decisions', () => {
    seed('daemon_restart', 10);
    const r = sweepAutonomyActionStates(['daemon_restart'], deps);
    expect(r.promoted).toEqual(['daemon_restart→notify']);
    const o = applyAutonomyOverride('daemon_restart', 'approve', [], deps);
    expect(o.decision).toBe('notify');
    expect(o.applied).toBe('relaxed_to:notify');
  });

  it('promotes to auto only with 20+ decisions and ≥0.9 outcome success', () => {
    seed('daemon_restart', 20, { ok: true });
    sweepAutonomyActionStates(['daemon_restart'], deps);
    const o = applyAutonomyOverride('daemon_restart', 'approve', [], deps);
    expect(o.decision).toBe('auto');
  });

  it('demotes instantly on a single incident and forces approve', () => {
    seed('daemon_restart', 20, { ok: true });
    sweepAutonomyActionStates(['daemon_restart'], deps);
    recordAutonomyOutcome(
      {
        action_id: 'daemon_restart',
        decision: 'auto',
        executed: true,
        ok: false,
        error: 'kickstart exit 1',
      },
      deps
    );
    const r = sweepAutonomyActionStates(['daemon_restart'], deps);
    expect(r.demoted).toEqual(['daemon_restart']);
    const o = applyAutonomyOverride('daemon_restart', 'auto', [], deps);
    expect(o.decision).toBe('approve');
    expect(o.applied).toBe('demoted');
  });

  it('never relaxes when an escalation rule fired', () => {
    seed('daemon_restart', 10);
    sweepAutonomyActionStates(['daemon_restart'], deps);
    const o = applyAutonomyOverride('daemon_restart', 'approve', ['never_auto'], deps);
    expect(o.decision).toBe('approve');
    expect(o.applied).toBeUndefined();
  });

  it('ignores a malformed overrides file (fail-safe to base decision)', () => {
    safeWriteFile(abs(AUTONOMY_OVERRIDES_PATH), '{not json');
    const o = applyAutonomyOverride('daemon_restart', 'notify', [], deps);
    expect(o.decision).toBe('notify');
  });

  it('persists promotion state to the runtime overrides file', () => {
    seed('daemon_restart', 10);
    sweepAutonomyActionStates(['daemon_restart'], deps);
    const onDisk = JSON.parse(
      safeReadFile(abs(AUTONOMY_OVERRIDES_PATH), { encoding: 'utf8' }) as string
    );
    expect(onDisk.overrides.daemon_restart.relaxed_to).toBe('notify');
    expect(onDisk.overrides.daemon_restart.stats.decisions).toBe(10);
  });
});
