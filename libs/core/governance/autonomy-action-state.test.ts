import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeReadFile, safeWriteFile } from '../secure-io.js';
import * as learningPolicy from './autonomy-learning-policy.js';
import {
  listAutonomyActionIds,
  recordAutonomyOutcome,
  actionAutonomyStats,
  applyAutonomyOverride,
  sweepAutonomyActionStates,
  AUTONOMY_OUTCOMES_PATH,
  AUTONOMY_OVERRIDES_PATH,
  recordAutonomyExecution,
  autonomyOverridesLockId,
} from './autonomy-action-state.js';

describe('autonomyOverridesLockId', () => {
  it('stays a short, stable, per-file id however long the root is', () => {
    const deep = path.join('/', 'x'.repeat(200), 'y'.repeat(200), 'autonomy-action-overrides.json');
    const id = autonomyOverridesLockId(deep);
    expect(id).toMatch(/^autonomy-learning-[0-9a-f]{64}$/u);
    expect(autonomyOverridesLockId(deep)).toBe(id);
    expect(autonomyOverridesLockId(`${deep}.other`)).not.toBe(id);
  });
});

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
  afterEach(() => vi.restoreAllMocks());

  it('records decisions and computes stats over the window', () => {
    seed('daemon_restart', 5);
    const s = actionAutonomyStats('daemon_restart', deps);
    expect(s.decisions).toBe(5);
    expect(s.incidents).toBe(0);
  });

  it('promotes approve→notify after enough successful executions', () => {
    seed('daemon_restart', 10, { ok: true });
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

  it('never treats repeated blocked decisions as execution evidence', () => {
    seed('daemon_restart', 100);
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], deps).decision).toBe('approve');
    safeWriteFile(
      abs(AUTONOMY_OVERRIDES_PATH),
      JSON.stringify({
        version: 1,
        overrides: {
          daemon_restart: { relaxed_to: 'notify' },
        },
      })
    );
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], deps).decision).toBe('approve');
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

  it('lists distinct action ids recorded in the ledger', () => {
    seed('daemon_restart', 3);
    seed('auto_checkpoint', 2);
    expect(listAutonomyActionIds(deps).sort()).toEqual(['auto_checkpoint', 'daemon_restart']);
  });

  it('persists promotion state to the runtime overrides file', () => {
    seed('daemon_restart', 10, { ok: true });
    sweepAutonomyActionStates(['daemon_restart'], deps);
    const onDisk = JSON.parse(
      safeReadFile(abs(AUTONOMY_OVERRIDES_PATH), { encoding: 'utf8' }) as string
    );
    expect(onDisk.overrides.daemon_restart.relaxed_to).toBe('notify');
    expect(onDisk.overrides.daemon_restart.stats.decisions).toBe(10);
  });

  it('never shares system learning or writes tenant evidence into the shared ledger', () => {
    seed('daemon_restart', 20, { ok: true });
    sweepAutonomyActionStates(['daemon_restart'], deps);
    const tenantDeps = { ...deps, tenantSlug: 'acme' };
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], tenantDeps)).toEqual({
      decision: 'approve',
    });
    const before = safeReadFile(abs(AUTONOMY_OUTCOMES_PATH), { encoding: 'utf8' });
    recordAutonomyOutcome(
      { action_id: 'daemon_restart', decision: 'auto', executed: true, ok: false },
      tenantDeps
    );
    recordAutonomyExecution(
      { action_id: 'daemon_restart', receipt_id: 'failure-1', ok: false },
      tenantDeps
    );
    expect(safeReadFile(abs(AUTONOMY_OUTCOMES_PATH), { encoding: 'utf8' })).toBe(before);
    expect(actionAutonomyStats('daemon_restart', tenantDeps).decisions).toBe(1);
    expect(actionAutonomyStats('daemon_restart', tenantDeps).incidents).toBe(2);
    expect(sweepAutonomyActionStates(['daemon_restart'], tenantDeps).promoted).toEqual([]);
    expect(listAutonomyActionIds(tenantDeps)).toEqual(['daemon_restart']);
  });

  it('learns independently per tenant without granting sibling or system authority', () => {
    const tenantDeps = { ...deps, tenantSlug: 'acme' };
    for (let i = 0; i < 20; i++) {
      recordAutonomyOutcome(
        { action_id: 'mission_start_mandate', decision: 'approve', executed: false },
        tenantDeps
      );
      recordAutonomyExecution(
        { action_id: 'mission_start_mandate', receipt_id: `mission-${i}`, ok: true },
        tenantDeps
      );
    }
    expect(sweepAutonomyActionStates(['mission_start_mandate'], tenantDeps).promoted).toEqual([
      'mission_start_mandate→auto',
    ]);
    expect(applyAutonomyOverride('mission_start_mandate', 'approve', [], tenantDeps).decision).toBe(
      'auto'
    );
    expect(
      applyAutonomyOverride('mission_start_mandate', 'approve', [], {
        ...deps,
        tenantSlug: 'other',
      }).decision
    ).toBe('approve');
    expect(applyAutonomyOverride('mission_start_mandate', 'approve', [], deps).decision).toBe(
      'approve'
    );
  });

  it('uses configured promotion thresholds and fails closed when learning is disabled', () => {
    const policy = learningPolicy.loadAutonomyLearningPolicy();
    const spy = vi
      .spyOn(learningPolicy, 'loadAutonomyLearningPolicy')
      .mockReturnValue({ ...policy, notify_min_decisions: 3, auto_min_decisions: 5 });
    seed('daemon_restart', 3, { ok: true });
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([
      'daemon_restart→notify',
    ]);
    spy.mockReturnValue({ ...policy, enabled: false });
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], deps).decision).toBe('approve');
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
  });

  it('does not promote during an active cooldown even with fresh clean evidence', () => {
    seed('daemon_restart', 20, { ok: true });
    const future = new Date(Date.now() + 60_000).toISOString();
    safeWriteFile(
      abs(AUTONOMY_OVERRIDES_PATH),
      JSON.stringify({ version: 1, overrides: { daemon_restart: { demoted_until: future } } })
    );
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
    expect(applyAutonomyOverride('daemon_restart', 'auto', [], deps).decision).toBe('approve');
  });

  it('honors the same configured incident allowance for promotion and demotion', () => {
    const policy = learningPolicy.loadAutonomyLearningPolicy();
    vi.spyOn(learningPolicy, 'loadAutonomyLearningPolicy').mockReturnValue({
      ...policy,
      max_incidents: 1,
    });
    seed('daemon_restart', 20, { ok: true });
    recordAutonomyExecution(
      { action_id: 'daemon_restart', receipt_id: 'failure-1', ok: false },
      deps
    );
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([
      'daemon_restart→auto',
    ]);
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], deps).decision).toBe('auto');
    recordAutonomyExecution(
      { action_id: 'daemon_restart', receipt_id: 'failure-2', ok: false },
      deps
    );
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).demoted).toEqual(['daemon_restart']);
    expect(applyAutonomyOverride('daemon_restart', 'auto', [], deps).decision).toBe('approve');
  });

  it('fails closed on corrupted evidence and malformed override entries', () => {
    seed('daemon_restart', 20, { ok: true });
    const ledger = String(safeReadFile(abs(AUTONOMY_OUTCOMES_PATH), { encoding: 'utf8' }));
    safeWriteFile(abs(AUTONOMY_OUTCOMES_PATH), ledger + '{truncated\n');
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
    safeWriteFile(
      abs(AUTONOMY_OVERRIDES_PATH),
      JSON.stringify({ version: 1, overrides: { daemon_restart: null } })
    );
    expect(applyAutonomyOverride('daemon_restart', 'approve', [], deps).decision).toBe('approve');
  });

  it('rejects invalid tenant namespaces instead of using system state', () => {
    expect(() =>
      recordAutonomyExecution(
        { action_id: 'daemon_restart', receipt_id: 'one', ok: true },
        { ...deps, tenantSlug: '../escape' }
      )
    ).toThrow();
  });

  it('does not erase malformed execution timestamps from otherwise clean evidence', () => {
    seed('daemon_restart', 20, { ok: true });
    const ledger = String(safeReadFile(abs(AUTONOMY_OUTCOMES_PATH), { encoding: 'utf8' }));
    safeWriteFile(
      abs(AUTONOMY_OUTCOMES_PATH),
      ledger +
        JSON.stringify({
          kind: 'execution',
          action_id: 'daemon_restart',
          executed: true,
          ok: false,
          recorded_at: 'invalid',
        }) +
        '\n'
    );
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
  });

  it('counts replayed execution receipts once and never lets success hide failure', () => {
    seed('daemon_restart', 30);
    for (let i = 0; i < 30; i++)
      recordAutonomyExecution(
        { action_id: 'daemon_restart', receipt_id: 'same-run', ok: true },
        deps
      );
    expect(actionAutonomyStats('daemon_restart', deps).succeeded).toBe(1);
    expect(sweepAutonomyActionStates(['daemon_restart'], deps).promoted).toEqual([]);
    recordAutonomyExecution(
      { action_id: 'daemon_restart', receipt_id: 'same-run', ok: false },
      deps
    );
    expect(actionAutonomyStats('daemon_restart', deps).incidents).toBe(1);
  });
});
