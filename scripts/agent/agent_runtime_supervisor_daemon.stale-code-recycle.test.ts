import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compilerBusy: false,
  recordDaemonHeartbeat: vi.fn(),
  appendSupervisorEvent: vi.fn(),
  ensureAgentRuntime: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@agent/core/build-coordination', () => ({
  tryInspectCompilerOutputs: async (inspect: () => Promise<unknown>) =>
    mocks.compilerBusy ? { deferred: true } : { deferred: false, value: await inspect() },
}));
vi.mock('@agent/core/agent/agent-runtime-supervisor', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/agent/agent-runtime-supervisor')),
  ensureAgentRuntime: mocks.ensureAgentRuntime,
}));
vi.mock('@agent/core/process-guards', () => ({ installProcessGuards: vi.fn() }));
vi.mock('@agent/core/tool/runtime-health-history', () => ({
  recordRuntimeHealthSample: vi.fn(),
}));
vi.mock('@agent/core/daemon-heartbeat', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/daemon-heartbeat')),
  recordDaemonHeartbeat: mocks.recordDaemonHeartbeat,
}));
vi.mock('@agent/core/agent/agent-runtime-events', () => ({
  appendSupervisorEvent: mocks.appendSupervisorEvent,
}));
vi.mock('@agent/core/core', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@agent/core/core')),
  logger: mocks.logger,
}));
vi.mock('@agent/core/agent/agent-runtime-supervisor-client', async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    '@agent/core/agent/agent-runtime-supervisor-client'
  )),
  computeSupervisorCodeStamp: () => 1000,
}));
vi.mock('@agent/core/reasoning/reasoning-bootstrap', () => ({
  installReasoningBackends: vi.fn(() => true),
  reselectReasoningBackends: vi.fn(),
}));

import {
  STALE_CODE_RECYCLE_EXIT_CODE,
  decideStaleCodeRecycle,
  detectSupervisingServiceManager,
  dotSupervisorHeartbeatDetails,
  handleRequest,
  maybeSelfRecycleOnStaleCode,
  resetDotSweepStateForTests,
  runDotSweepOnce,
  staleCodeSelfRecycleEnabled,
  type StaleCodeRecycleInput,
} from './agent_runtime_supervisor_daemon.js';

const LABEL = 'com.kyberion.agent-runtime-supervisor.ws-031f3a9010e8adf0';

function input(overrides: Partial<StaleCodeRecycleInput> = {}): StaleCodeRecycleInput {
  return {
    enabled: true,
    serviceManager: 'launchd',
    loadedStamp: 1000,
    distStamp: 2000,
    previousCandidateStamp: 2000,
    dotSweepInFlight: false,
    inflightAsks: 0,
    busyRuntimes: 0,
    delegatedWorkers: 0,
    nowMs: 10_000_000,
    lastSelfRecycleAtMs: null,
    minIntervalMs: 15 * 60 * 1000,
    ...overrides,
  };
}

describe('decideStaleCodeRecycle', () => {
  it('recycles onto a settled newer dist when supervised and idle', () => {
    expect(decideStaleCodeRecycle(input())).toEqual({ action: 'recycle', distStamp: 2000 });
  });

  it('does nothing when the dist matches the loaded build or a stamp is unreadable', () => {
    expect(decideStaleCodeRecycle(input({ distStamp: 1000 }))).toMatchObject({ reason: 'fresh' });
    expect(decideStaleCodeRecycle(input({ distStamp: 0 }))).toMatchObject({ reason: 'fresh' });
    expect(decideStaleCodeRecycle(input({ loadedStamp: 0 }))).toMatchObject({ reason: 'fresh' });
  });

  it('never recycles when disabled or not run by a service manager', () => {
    expect(decideStaleCodeRecycle(input({ enabled: false }))).toEqual({
      action: 'none',
      reason: 'disabled',
    });
    expect(decideStaleCodeRecycle(input({ serviceManager: null }))).toEqual({
      action: 'none',
      reason: 'unsupervised',
    });
  });

  it('waits while a build holds the outputs or the new stamp has not settled', () => {
    expect(decideStaleCodeRecycle(input({ distStamp: null }))).toMatchObject({
      action: 'wait',
      reason: 'build_running',
    });
    expect(decideStaleCodeRecycle(input({ previousCandidateStamp: null }))).toMatchObject({
      action: 'wait',
      reason: 'settling',
    });
    expect(decideStaleCodeRecycle(input({ previousCandidateStamp: 1500 }))).toMatchObject({
      reason: 'settling',
    });
  });

  it('waits on in-flight work: sweep, asks, busy runtimes, delegated workers', () => {
    expect(decideStaleCodeRecycle(input({ dotSweepInFlight: true }))).toMatchObject({
      reason: 'sweep_in_flight',
    });
    expect(decideStaleCodeRecycle(input({ inflightAsks: 1 }))).toMatchObject({
      reason: 'asks_in_flight',
    });
    expect(decideStaleCodeRecycle(input({ busyRuntimes: 2 }))).toMatchObject({
      reason: 'runtimes_busy',
    });
    expect(decideStaleCodeRecycle(input({ delegatedWorkers: 1 }))).toMatchObject({
      reason: 'delegated_workers_running',
    });
  });

  it('allows at most one self-recycle per min interval (restart-loop guard)', () => {
    const minIntervalMs = 15 * 60 * 1000;
    expect(
      decideStaleCodeRecycle(input({ lastSelfRecycleAtMs: 10_000_000 - minIntervalMs + 1 }))
    ).toMatchObject({ action: 'wait', reason: 'recycle_backoff' });
    expect(
      decideStaleCodeRecycle(input({ lastSelfRecycleAtMs: 10_000_000 - minIntervalMs }))
    ).toMatchObject({ action: 'recycle' });
  });
});

describe('detectSupervisingServiceManager', () => {
  it('recognises the launchd job by its XPC_SERVICE_NAME label', () => {
    expect(detectSupervisingServiceManager({ XPC_SERVICE_NAME: LABEL }, 42)).toBe('launchd');
    expect(
      detectSupervisingServiceManager(
        { XPC_SERVICE_NAME: 'com.kyberion.agent-runtime-supervisor' },
        42
      )
    ).toBe('launchd');
  });

  it('ignores terminal sessions and other kyberion jobs', () => {
    expect(detectSupervisingServiceManager({ XPC_SERVICE_NAME: '0' }, 42)).toBeNull();
    expect(
      detectSupervisingServiceManager({ XPC_SERVICE_NAME: 'com.kyberion.chronos.ws-1' }, 42)
    ).toBeNull();
    expect(
      detectSupervisingServiceManager(
        { XPC_SERVICE_NAME: 'com.kyberion.agent-runtime-supervisorX' },
        42
      )
    ).toBeNull();
    expect(detectSupervisingServiceManager({}, 42)).toBeNull();
  });

  it('recognises systemd only when this process is the unit main pid', () => {
    expect(
      detectSupervisingServiceManager({ INVOCATION_ID: 'abc', SYSTEMD_EXEC_PID: '42' }, 42)
    ).toBe('systemd');
    // A shell that inherited a service environment is not the unit's main process.
    expect(
      detectSupervisingServiceManager({ INVOCATION_ID: 'abc', SYSTEMD_EXEC_PID: '7' }, 42)
    ).toBeNull();
    expect(detectSupervisingServiceManager({ INVOCATION_ID: 'abc' }, 42)).toBeNull();
  });
});

describe('staleCodeSelfRecycleEnabled', () => {
  it('defaults on and honours explicit off values', () => {
    expect(staleCodeSelfRecycleEnabled(undefined)).toBe(true);
    expect(staleCodeSelfRecycleEnabled('1')).toBe(true);
    for (const off of ['0', 'false', 'OFF', 'no'])
      expect(staleCodeSelfRecycleEnabled(off)).toBe(false);
  });
});

describe('maybeSelfRecycleOnStaleCode', () => {
  let stamp: number;
  let clock: number;
  const drain = vi.fn(async () => undefined);
  const exit = vi.fn();
  const deps = () => ({
    enabled: true,
    serviceManager: 'launchd' as const,
    loadedStamp: 1000,
    computeStamp: () => stamp,
    now: () => clock,
    busyRuntimes: () => 0,
    delegatedWorkers: () => 0,
    drain,
    exit,
  });

  beforeEach(() => {
    resetDotSweepStateForTests();
    mocks.compilerBusy = false;
    stamp = 2000;
    clock = 10_000_000;
    drain.mockClear();
    exit.mockClear();
    mocks.recordDaemonHeartbeat.mockClear();
    mocks.appendSupervisorEvent.mockClear();
    mocks.ensureAgentRuntime.mockReset();
  });
  afterEach(() => resetDotSweepStateForTests());

  it('requires two consecutive identical stamps, then drains and exits non-zero', async () => {
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ reason: 'settling' });
    expect(exit).not.toHaveBeenCalled();
    expect(await maybeSelfRecycleOnStaleCode(deps())).toEqual({
      action: 'recycle',
      distStamp: 2000,
    });
    expect(drain).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(STALE_CODE_RECYCLE_EXIT_CODE);
    expect(STALE_CODE_RECYCLE_EXIT_CODE).not.toBe(0);
    expect(mocks.appendSupervisorEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'agent_runtime_supervisor_daemon_stopping',
        reason: 'stale_code_self_recycle',
      })
    );
    expect(mocks.recordDaemonHeartbeat).toHaveBeenCalledWith(
      'agent-runtime-supervisor-daemon',
      expect.objectContaining({
        status: 'stopping',
        details: expect.objectContaining({
          reason: 'stale_code_self_recycle',
          last_self_recycle_at: new Date(clock).toISOString(),
        }),
      })
    );
    // Recycle state carried in the heartbeat; no new sweep starts after commit.
    expect(dotSupervisorHeartbeatDetails(clock)).toMatchObject({
      last_self_recycle_at: new Date(clock).toISOString(),
    });
    expect(await runDotSweepOnce(new Date(clock), { listCharters: () => [] })).toBe(0);
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ action: 'wait' });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('restarts the settle window when the stamp moves or a build holds the lock', async () => {
    await maybeSelfRecycleOnStaleCode(deps());
    stamp = 3000;
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ reason: 'settling' });
    mocks.compilerBusy = true;
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ reason: 'build_running' });
    mocks.compilerBusy = false;
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ reason: 'settling' });
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ action: 'recycle' });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('refuses new mutations while the committed recycle is draining', async () => {
    let finishDrain!: () => void;
    const pendingDrain = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    const parked = { ...deps(), drain: vi.fn(() => pendingDrain) };
    await maybeSelfRecycleOnStaleCode(parked);
    const recycling = maybeSelfRecycleOnStaleCode(parked);
    await vi.waitFor(() => expect(parked.drain).toHaveBeenCalledOnce());
    try {
      for (const method of [
        'ensure',
        'ask',
        'restart',
        'refresh',
        'shutdown',
        'touch',
        'delegated_enqueue',
        'terminate',
      ] as const) {
        expect(await handleRequest({ id: method, method, payload: {} }, 'test')).toMatchObject({
          ok: false,
          errorDetail: { type: 'busy', retry_after_ms: 1000 },
        });
      }
      expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
      expect(await handleRequest({ id: 'health', method: 'health' }, 'test')).toMatchObject({
        ok: true,
      });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      finishDrain();
      await recycling;
    }
    expect(exit).toHaveBeenCalledOnce();
  });

  it('waits for an admitted ensure before it publishes a runtime, including failed calls', async () => {
    let rejectEnsure!: (error: Error) => void;
    mocks.ensureAgentRuntime.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectEnsure = reject;
        })
    );
    const ensuring = handleRequest(
      { id: 'ensure', method: 'ensure', payload: { agentId: 'pending' } },
      'test'
    );
    await maybeSelfRecycleOnStaleCode(deps());
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ reason: 'asks_in_flight' });
    expect(drain).not.toHaveBeenCalled();
    rejectEnsure(new Error('boot failed'));
    expect(await ensuring).toMatchObject({ ok: false, error: 'boot failed' });
    expect(await maybeSelfRecycleOnStaleCode(deps())).toMatchObject({ action: 'recycle' });
  });

  it('stays warn-only when unsupervised or busy', async () => {
    const unsupervised = { ...deps(), serviceManager: null };
    await maybeSelfRecycleOnStaleCode(unsupervised);
    expect(await maybeSelfRecycleOnStaleCode(unsupervised)).toMatchObject({
      reason: 'unsupervised',
    });
    const busy = { ...deps(), busyRuntimes: () => 1 };
    await maybeSelfRecycleOnStaleCode(busy);
    expect(await maybeSelfRecycleOnStaleCode(busy)).toMatchObject({ reason: 'runtimes_busy' });
    expect(exit).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  });
});
