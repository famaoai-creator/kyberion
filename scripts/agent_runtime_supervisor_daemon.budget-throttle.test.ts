import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import type { DueDotTrigger } from '@agent/core/dot/dot-runtime';

const mocks = vi.hoisted(() => ({
  housekeeping: vi.fn(async () => ({ settled: [], signals: 0, digest: false, errors: [] })),
  recordDaemonHeartbeat: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/process-guards', () => ({ installProcessGuards: vi.fn() }));
vi.mock('@agent/core/tool/runtime-health-history', () => ({ recordRuntimeHealthSample: vi.fn() }));
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
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: vi.fn(() => true),
  reselectReasoningBackends: vi.fn(),
}));
vi.mock('@agent/core/governance/approval-veto-window', () => ({ tickVetoWindows: vi.fn() }));
vi.mock('@agent/core/dot/dot-dispatch', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/dot/dot-dispatch')),
  runDotHousekeeping: mocks.housekeeping,
}));
vi.mock('@agent/core/dot/dot-runtime', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/dot/dot-runtime')),
  dotDailyTokenCapReached: () => false,
  evaluateDotTriggersDue: (charter: DotCharter): DueDotTrigger[] => [
    { trigger: { kind: 'cron', cron: '* * * * *' }, key: `cron:${charter.dot_id}` },
  ],
  evaluateDotProbeTriggers: async () => [],
  applyDotWakeCircuit: (_charter: DotCharter, due: DueDotTrigger[]) => due,
  recordDotWakeOutcome: vi.fn(),
}));
vi.mock('@agent/core/trigger-runner', () => ({
  resolveCurrentTriggerAuthority: () => ({ authority_role: 'test', level: 1 }),
  createTriggerRunner: () => ({
    run: async (request: { idempotencyKey: string }, deliver: () => Promise<string>) => {
      await deliver();
      return { ...request, status: 'delivered', recordedAt: '' };
    },
  }),
}));

import { resetDotSweepStateForTests, runDotSweepOnce } from './agent_runtime_supervisor_daemon.js';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';

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
  resetDotSweepStateForTests();
  DOT_SUPERVISOR_STEPS.length = 0;
  vi.clearAllMocks();
});

describe('runDotSweepOnce org budget hard throttle', () => {
  it('skips wakes for a hard-throttled dot but keeps housekeeping and heartbeat', async () => {
    const woken: string[] = [];
    const wake = async (loaded: LoadedDotCharter) => {
      woken.push(loaded.charter.dot_id);
      return { dot_id: loaded.charter.dot_id, outcome: 'delivered' as const };
    };
    const delivered = await runDotSweepOnce(NOW, {
      listCharters: () => [A, B],
      wake,
      budgetThrottle: (c) => (c.dot_id === 'a' ? 'hard' : 'soft'),
    });
    expect(woken).toEqual(['b']);
    expect(delivered).toBe(1);
    expect(mocks.housekeeping).toHaveBeenCalledTimes(2);
    expect(mocks.recordDaemonHeartbeat).toHaveBeenCalledWith('dot-a', {
      status: 'running',
      details: { dot_id: 'a', trigger: 'budget-hard' },
    });
  });

  it('fails open when the budget evaluation throws', async () => {
    const woken: string[] = [];
    await runDotSweepOnce(NOW, {
      listCharters: () => [A],
      wake: async (loaded) => {
        woken.push(loaded.charter.dot_id);
        return { dot_id: 'a', outcome: 'delivered' as const };
      },
      budgetThrottle: () => {
        throw new Error('policy unreadable');
      },
    });
    expect(woken).toEqual(['a']);
    expect(
      mocks.logger.warn.mock.calls.some(([line]) =>
        String(line).includes('budget evaluation failed')
      )
    ).toBe(true);
  });
});
