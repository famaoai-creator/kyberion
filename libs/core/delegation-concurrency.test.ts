import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const recordGovernanceAction = vi.fn();
const onKillSwitchTermination = vi.fn((listener: (agentId: string, reason: string) => void) => {
  killSwitchListeners.push(listener);
  return () => {
    const idx = killSwitchListeners.indexOf(listener);
    if (idx >= 0) killSwitchListeners.splice(idx, 1);
  };
});
let killSwitchListeners: Array<(agentId: string, reason: string) => void> = [];

vi.mock('./kill-switch.js', () => ({
  recordGovernanceAction: (...args: unknown[]) => recordGovernanceAction(...args),
  onKillSwitchTermination: (listener: any) => onKillSwitchTermination(listener),
}));

let tmpDir: string;

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    shared: (sub = '') => path.join(tmpDir, sub),
  },
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: any) => actual.readFileSync(p, opts),
    safeMkdir: (p: string, opts: any) => actual.mkdirSync(p, opts),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
  };
});

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import {
  withDelegationSlot,
  getDelegationConcurrencyStats,
  withWallClockBudget,
  DelegationWallClockExceededError,
  terminateAllActiveDelegationChildren,
  wireDelegationKillSwitchIntegration,
  peekPersistedDelegationChildrenRegistry,
  getRecordedDelegationTimeouts,
  resetDelegationConcurrencyStateForTests,
  type DelegationChildHandle,
} from './delegation-concurrency.js';

function makeDeferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('delegation-concurrency', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-concurrency-'));
    killSwitchListeners = [];
    recordGovernanceAction.mockClear();
    onKillSwitchTermination.mockClear();
    resetDelegationConcurrencyStateForTests();
    delete process.env.KYBERION_DELEGATION_MAX_CONCURRENCY;
    delete process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY;
    delete process.env.KYBERION_DELEGATION_PROVIDER_CAPS;
    delete process.env.KYBERION_DELEGATION_WALL_CLOCK_MS;
    delete process.env.KYBERION_DELEGATION_KILL_GRACE_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDelegationConcurrencyStateForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('withDelegationSlot', () => {
    it('never exceeds the global or per-provider cap under 20 queued delegations', async () => {
      process.env.KYBERION_DELEGATION_MAX_CONCURRENCY = '3';
      process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY = '2';

      let globalActive = 0;
      let maxGlobalActive = 0;
      const perProviderActive: Record<string, number> = { claude: 0, codex: 0 };
      const perProviderMax: Record<string, number> = { claude: 0, codex: 0 };
      const pendingDeferreds: Array<{ resolve: () => void }> = [];

      const providers = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'claude' : 'codex'));
      const runs = providers.map((provider) =>
        withDelegationSlot({ provider }, async () => {
          globalActive += 1;
          perProviderActive[provider] += 1;
          maxGlobalActive = Math.max(maxGlobalActive, globalActive);
          perProviderMax[provider] = Math.max(
            perProviderMax[provider],
            perProviderActive[provider]
          );

          const deferred = makeDeferred<void>();
          pendingDeferreds.push(deferred);
          await deferred.promise;

          globalActive -= 1;
          perProviderActive[provider] -= 1;
        })
      );

      // Check caps mid-flight too (the max recorded so far must never have
      // exceeded either cap at any point, not just once everything settles).
      await new Promise((r) => setTimeout(r, 0));
      expect(maxGlobalActive).toBeLessThanOrEqual(3);
      expect(perProviderMax.claude).toBeLessThanOrEqual(2);
      expect(perProviderMax.codex).toBeLessThanOrEqual(2);

      const midStats = getDelegationConcurrencyStats();
      expect(midStats.global.cap).toBe(3);
      expect(midStats.providers.claude.cap).toBe(2);
      expect(midStats.global.active).toBeLessThanOrEqual(3);
      expect(midStats.global.active + midStats.global.queued).toBe(20);

      // Drain in rounds: resolve whatever is currently active, let the next
      // batch acquire its slots, repeat until every task has completed.
      for (let round = 0; round < 20 && pendingDeferreds.length > 0; round += 1) {
        const batch = pendingDeferreds.splice(0, pendingDeferreds.length);
        batch.forEach((d) => d.resolve());
        await new Promise((r) => setTimeout(r, 0));
      }
      await Promise.all(runs);

      expect(maxGlobalActive).toBeLessThanOrEqual(3);
      expect(perProviderMax.claude).toBeLessThanOrEqual(2);
      expect(perProviderMax.codex).toBeLessThanOrEqual(2);

      const finalStats = getDelegationConcurrencyStats();
      expect(finalStats.global.active).toBe(0);
      expect(finalStats.global.queued).toBe(0);
    });

    it('completes same-provider queued delegations in FIFO order', async () => {
      process.env.KYBERION_DELEGATION_PROVIDER_MAX_CONCURRENCY = '1';
      const order: number[] = [];
      const gate = makeDeferred<void>();

      const runs = [0, 1, 2, 3, 4].map((i) =>
        withDelegationSlot({ provider: 'claude' }, async () => {
          if (i === 0) await gate.promise; // hold the only slot until we say go
          order.push(i);
        })
      );

      // Give tasks 1..4 a chance to queue behind task 0.
      await new Promise((r) => setTimeout(r, 0));
      gate.resolve();
      await Promise.all(runs);

      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('never rejects due to saturation — every queued call eventually resolves', async () => {
      process.env.KYBERION_DELEGATION_MAX_CONCURRENCY = '1';
      const results = await Promise.all(
        [0, 1, 2].map((i) => withDelegationSlot({ provider: 'agy' }, async () => i * 10))
      );
      expect(results).toEqual([0, 10, 20]);
    });
  });

  describe('withWallClockBudget', () => {
    it('kills the fake child (SIGTERM then SIGKILL) on expiry and records the timeout', async () => {
      vi.useFakeTimers();
      const child: DelegationChildHandle = { pid: 4242, kill: vi.fn() };
      const never = new Promise<string>(() => {});

      const result = withWallClockBudget(
        { provider: 'claude', budgetMs: 1000, killGraceMs: 500, child },
        () => never
      );
      const assertion = expect(result).rejects.toBeInstanceOf(DelegationWallClockExceededError);

      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(500);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      const timeouts = getRecordedDelegationTimeouts();
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toMatchObject({ provider: 'claude', budgetMs: 1000 });
    });

    it('resolves normally and unregisters the child when fn finishes before the budget', async () => {
      vi.useFakeTimers();
      const child: DelegationChildHandle = { pid: 7, kill: vi.fn() };

      const out = await withWallClockBudget(
        { provider: 'codex', budgetMs: 5000, child },
        async () => 'done'
      );

      expect(out).toBe('done');
      expect(child.kill).not.toHaveBeenCalled();
      expect(peekPersistedDelegationChildrenRegistry()).toEqual([]);
    });

    it('persists an active-child record while running and removes it on clean exit', async () => {
      const child: DelegationChildHandle = { pid: 99, kill: vi.fn() };
      const deferred = makeDeferred<string>();

      const runPromise = withWallClockBudget(
        { provider: 'claude', budgetMs: 60000, child, id: 'test-id-1' },
        () => deferred.promise
      );

      await new Promise((r) => setTimeout(r, 0));
      const registry = peekPersistedDelegationChildrenRegistry();
      expect(registry).toHaveLength(1);
      expect(registry[0]).toMatchObject({ id: 'test-id-1', provider: 'claude', pid: 99 });

      deferred.resolve('ok');
      await runPromise;
      expect(peekPersistedDelegationChildrenRegistry()).toEqual([]);
    });

    it('propagates a normal fn() rejection without treating it as a timeout', async () => {
      const child: DelegationChildHandle = { pid: 5, kill: vi.fn() };
      await expect(
        withWallClockBudget({ provider: 'claude', budgetMs: 60000, child }, async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(child.kill).not.toHaveBeenCalled();
      expect(getRecordedDelegationTimeouts()).toHaveLength(0);
    });
  });

  describe('kill-switch integration', () => {
    it('terminateAllActiveDelegationChildren kills every registered child', async () => {
      vi.useFakeTimers();
      process.env.KYBERION_DELEGATION_KILL_GRACE_MS = '200';
      const childA: DelegationChildHandle = { pid: 1, kill: vi.fn() };
      const childB: DelegationChildHandle = { pid: 2, kill: vi.fn() };
      const never = new Promise<void>(() => {});

      void withWallClockBudget({ provider: 'claude', budgetMs: 60000, child: childA }, () => never);
      void withWallClockBudget({ provider: 'codex', budgetMs: 60000, child: childB }, () => never);

      const { terminatedIds } = terminateAllActiveDelegationChildren('test-reason');
      expect(terminatedIds).toHaveLength(2);
      expect(childA.kill).toHaveBeenCalledWith('SIGTERM');
      expect(childB.kill).toHaveBeenCalledWith('SIGTERM');
      expect(childA.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(200);
      expect(childA.kill).toHaveBeenCalledWith('SIGKILL');
      expect(childB.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('wireDelegationKillSwitchIntegration registers a listener that cascades kill-switch firings to active children', async () => {
      const child: DelegationChildHandle = { pid: 3, kill: vi.fn() };
      const never = new Promise<void>(() => {});

      await wireDelegationKillSwitchIntegration();
      expect(onKillSwitchTermination).toHaveBeenCalledTimes(1);

      void withWallClockBudget({ provider: 'claude', budgetMs: 60000, child }, () => never);

      expect(killSwitchListeners).toHaveLength(1);
      killSwitchListeners[0]('some-agent-id', 'anomaly detected');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('is idempotent — repeated calls only wire once', async () => {
      await wireDelegationKillSwitchIntegration();
      await wireDelegationKillSwitchIntegration();
      await wireDelegationKillSwitchIntegration();
      expect(onKillSwitchTermination).toHaveBeenCalledTimes(1);
    });
  });
});
