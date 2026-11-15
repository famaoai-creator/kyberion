import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import type { DueDotTrigger } from '@agent/core/dot/dot-runtime';

const mocks = vi.hoisted(() => ({
  codeStamp: { value: 1000 },
  compilerBusy: false,
  due: new Map<string, DueDotTrigger[]>(),
  runnerSources: [] as string[],
  realRunner: null as import('@agent/core/trigger-runner').TriggerRunner | null,
  reselect: vi.fn(),
  recordDotWakeOutcome: vi.fn(),
  recordDaemonHeartbeat: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/build-coordination', () => ({
  tryInspectCompilerOutputs: async (inspect: () => Promise<unknown>) =>
    mocks.compilerBusy ? { deferred: true } : { deferred: false, value: await inspect() },
}));

vi.mock('@agent/core/process-guards', () => ({ installProcessGuards: vi.fn() }));
vi.mock('@agent/core/tool/runtime-health-history', () => ({
  recordRuntimeHealthSample: vi.fn(),
}));
vi.mock('@agent/core/daemon-heartbeat', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/daemon-heartbeat')),
  recordDaemonHeartbeat: mocks.recordDaemonHeartbeat,
}));
vi.mock('@agent/core/ops-alert', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/ops-alert')),
  sendOpsAlert: vi.fn(),
}));
vi.mock('@agent/core/core', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/core')),
  logger: mocks.logger,
}));
vi.mock('@agent/core/agent/agent-runtime-supervisor-client', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '@agent/core/agent/agent-runtime-supervisor-client'
  )),
  computeSupervisorCodeStamp: () => mocks.codeStamp.value,
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: vi.fn(() => true),
  reselectReasoningBackends: mocks.reselect,
}));
vi.mock('@agent/core/governance/approval-veto-window', () => ({ tickVetoWindows: vi.fn() }));
vi.mock('@agent/core/dot/dot-dispatch', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/dot/dot-dispatch')),
  runDotHousekeeping: vi.fn(async () => ({ settled: [], signals: 0, digest: false, errors: [] })),
}));
vi.mock('@agent/core/dot/dot-runtime', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/dot/dot-runtime')),
  dotDailyTokenCapReached: () => false,
  evaluateDotTriggersDue: (charter: DotCharter) => mocks.due.get(charter.dot_id) ?? [],
  evaluateDotProbeTriggers: async () => [],
  applyDotWakeCircuit: (_charter: DotCharter, due: DueDotTrigger[]) => due,
  recordDotWakeOutcome: mocks.recordDotWakeOutcome,
}));
vi.mock('@agent/core/trigger-runner', () => ({
  resolveCurrentTriggerAuthority: (tenantSlug?: string) =>
    mocks.realRunner
      ? {
          authority_role: 'chronos_gateway',
          level: 40,
          ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
        }
      : { authority_role: 'test', level: 1 },
  createTriggerRunner: () => ({
    run: async (
      request: import('@agent/core/trigger-runner').TriggerRequest,
      deliver: () => Promise<string>
    ) => {
      mocks.runnerSources.push(request.source);
      if (mocks.realRunner) return mocks.realRunner.run(request, deliver);
      try {
        await deliver();
        return { ...request, status: 'delivered', recordedAt: '' };
      } catch (error) {
        return {
          ...request,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          recordedAt: '',
        };
      }
    },
    records: () => mocks.realRunner?.records() ?? [],
  }),
}));

import {
  dotSupervisorHeartbeatDetails,
  isDotBackendFailure,
  resetDotSweepStateForTests,
  runDotSweepOnce,
} from './agent_runtime_supervisor_daemon.js';
import { DOT_SUPERVISOR_STEPS } from '../dot/dot_supervisor_extensions.js';
import { safeRmSync } from '@agent/core/secure-io';

const RECOVERY_ROOT = 'active/shared/tmp/dot-sweep-schedule-recovery';

function charter(dotId: string): DotCharter {
  return {
    kind: 'dot-charter',
    dot_id: dotId,
    version: '1.0.0',
    title: dotId,
    purpose: 'test',
    status: 'active',
    scope: { tier: 'public' },
    goal: { statement: 'test' },
    attention: { triggers: [{ kind: 'cron', cron: '* * * * *' }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
    runtime: { heartbeat_id: `dot-${dotId}` },
  };
}

const A: LoadedDotCharter = { path: 'dots/a.json', charter: charter('a') };
const B: LoadedDotCharter = { path: 'dots/b.json', charter: charter('b') };
const NOW = new Date('2026-10-04T10:00:00Z');

beforeEach(() => {
  // The module registers the real supervisor steps (outcomes, autonomy, …) at
  // import; they would write dot state into the live active/ tree.
  DOT_SUPERVISOR_STEPS.length = 0;
  resetDotSweepStateForTests();
  mocks.compilerBusy = false;
  mocks.due.clear();
  mocks.runnerSources.length = 0;
  mocks.realRunner = null;
  mocks.codeStamp.value = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  DOT_SUPERVISOR_STEPS.length = 0;
  safeRmSync(RECOVERY_ROOT, { recursive: true, force: true });
});

describe('runDotSweepOnce', () => {
  it.each([
    { tier: 'public' as const },
    { tier: 'confidential' as const, tenant_slug: 'tenant-a' },
    { tier: 'personal' as const, owner_nhi: 'owner-a' },
  ])(
    'retries a retained $tier schedule through the real TriggerRunner without consuming it',
    async (scope) => {
      const { createTriggerRunner } = await vi.importActual<
        typeof import('@agent/core/trigger-runner')
      >('@agent/core/trigger-runner');
      mocks.realRunner = createTriggerRunner({
        storePath: `${RECOVERY_ROOT}/${scope.tier}.jsonl`,
        now: () => NOW,
        authorityResolver: (authority) => authority,
      });
      const loaded = { ...A, charter: { ...A.charter, scope } };
      const trigger: DueDotTrigger = { trigger: { kind: 'followup' }, key: 'followup:original' };
      mocks.due.set('a', [trigger]);
      const wake = vi
        .fn()
        .mockResolvedValueOnce({ dot_id: 'a', outcome: 'delivered', trigger_retained: true })
        .mockResolvedValue({ dot_id: 'a', outcome: 'delivered' });
      const deps = {
        listCharters: () => [loaded],
        wake,
        budgetThrottle: () => 'normal' as const,
      };
      expect(await runDotSweepOnce(NOW, deps)).toBe(0);
      expect(mocks.realRunner.records().at(-1)?.status).toBe('failed');
      // An older supervisor may already have made the parent key terminal.
      // Upgrading must recover the frozen schedule without resetting that receipt.
      await mocks.realRunner.run(
        {
          idempotencyKey: 'dot:a:followup:original',
          source: 'wake',
          createdBy: { authority_role: 'chronos_gateway', level: 40 },
        },
        async () => 'legacy-delivery'
      );
      mocks.due.set('a', [{ ...trigger, followupRecovery: true }]);
      expect(await runDotSweepOnce(new Date(NOW.getTime() + 5 * 60_000), deps)).toBe(1);
      expect(mocks.realRunner.records().at(-1)).toMatchObject({
        status: 'delivered',
        idempotencyKey: 'dot:a:followup:original:schedule-recovery',
      });
      await runDotSweepOnce(new Date(NOW.getTime() + 6 * 60_000), deps);
      expect(wake).toHaveBeenCalledTimes(2);
    }
  );
  it('defers work while a compiler owns outputs without consuming triggers', async () => {
    mocks.compilerBusy = true;
    const listCharters = vi.fn(() => [A]);
    const wake = vi.fn();
    expect(await runDotSweepOnce(NOW, { listCharters, wake })).toBe(0);
    expect(listCharters).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(mocks.recordDotWakeOutcome).not.toHaveBeenCalled();
  });

  it('surfaces malformed charters in the heartbeat and still wakes the good ones', async () => {
    mocks.due.set('a', [{ trigger: { kind: 'cron', cron: '* * * * *' }, key: 'cron:a' }]);
    const woken: string[] = [];
    const listCharters = (errors: Array<{ path: string; error: string }>) => {
      errors.push({ path: 'dots/broken.json', error: 'Invalid dot charter: /status' });
      return [A];
    };
    const wake = async (loaded: LoadedDotCharter) => {
      woken.push(loaded.charter.dot_id);
      return { dot_id: loaded.charter.dot_id, outcome: 'delivered' as const };
    };
    expect(await runDotSweepOnce(NOW, { listCharters, wake })).toBe(1);
    await runDotSweepOnce(NOW, { listCharters, wake });
    expect(woken).toEqual(['a', 'a']);
    expect(dotSupervisorHeartbeatDetails().charter_errors).toEqual([
      { path: 'dots/broken.json', error: 'Invalid dot charter: /status' },
    ]);
    // Diagnostic warn, once per distinct error across sweeps.
    const charterWarns = mocks.logger.warn.mock.calls.filter(([line]) =>
      String(line).includes('charter skipped')
    );
    expect(charterWarns).toHaveLength(1);
    expect(String(charterWarns[0][0])).toMatch(/ — .* \| next: .* \| evidence: dots\/broken\.json/);
  });

  it('runs registered supervisor steps once per sweep, isolating a failing step', async () => {
    const seen: string[][] = [];
    DOT_SUPERVISOR_STEPS.push(
      {
        id: 'boom',
        run: async () => {
          throw new Error('step exploded');
        },
      },
      {
        id: 'record',
        run: async (_now, active) => void seen.push(active.map((l) => l.charter.dot_id)),
      }
    );
    await runDotSweepOnce(NOW, { listCharters: () => [A, B], wake: vi.fn() });
    expect(seen).toEqual([['a', 'b']]);
  });

  it('re-selects backends when every wake failed on the reasoning backend (rate-limited)', async () => {
    mocks.due.set('a', [{ trigger: { kind: 'cron', cron: '* * * * *' }, key: 'cron:a' }]);
    mocks.due.set('b', [{ trigger: { kind: 'followup' }, key: 'followup:1' }]);
    const reselectBackends = vi.fn();
    const wake = async (loaded: LoadedDotCharter) => ({
      dot_id: loaded.charter.dot_id,
      outcome: 'failed' as const,
      reason: 'no real reasoning backend in this process — next: …',
    });
    await runDotSweepOnce(NOW, { listCharters: () => [A, B], wake, reselectBackends });
    expect(reselectBackends).toHaveBeenCalledTimes(1);
    // A followup trigger reaches the runner as a wake.
    expect(mocks.runnerSources).toEqual(['cron', 'wake']);
    // Within 5 minutes: no second reselect.
    await runDotSweepOnce(new Date(NOW.getTime() + 60_000), {
      listCharters: () => [A, B],
      wake,
      reselectBackends,
    });
    expect(reselectBackends).toHaveBeenCalledTimes(1);
  });

  it('does not reselect when a wake failed for a dot-level reason', async () => {
    mocks.due.set('a', [{ trigger: { kind: 'cron', cron: '* * * * *' }, key: 'cron:a' }]);
    const reselectBackends = vi.fn();
    await runDotSweepOnce(NOW, {
      listCharters: () => [A],
      wake: async () => ({ dot_id: 'a', outcome: 'failed' as const, reason: 'charter unreadable' }),
      reselectBackends,
    });
    expect(reselectBackends).not.toHaveBeenCalled();
    expect(isDotBackendFailure('generateWithTools failed across 0 candidate(s): ')).toBe(true);
  });
});

describe('dotSupervisorHeartbeatDetails', () => {
  it('flags stale code when the core dist changed after start, warning at most hourly', () => {
    expect(dotSupervisorHeartbeatDetails().stale_code).toBeUndefined();
    mocks.codeStamp.value = 2000;
    const details = dotSupervisorHeartbeatDetails(NOW.getTime());
    expect(details).toMatchObject({ stale_code: true, code_stamp: 1000, dist_stamp: 2000 });
    dotSupervisorHeartbeatDetails(NOW.getTime() + 60_000);
    const staleWarns = mocks.logger.warn.mock.calls.filter(([line]) =>
      String(line).includes('stale code')
    );
    expect(staleWarns).toHaveLength(1);
  });
});
