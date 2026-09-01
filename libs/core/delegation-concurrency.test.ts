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
    rootDir: () => path.join('/tmp', 'kyberion-test-root'),
    shared: (sub = '') => path.join(tmpDir, sub),
    knowledge: (sub = '') => path.join('/tmp', 'kyberion-test-knowledge', sub),
    rootResolve: (sub = '') => path.join('/tmp', 'kyberion-test-root', sub),
  },
  // Named exports (as opposed to the `pathResolver` object above) are what
  // `storage-janitor.ts` imports — provided here too so the shape-drift /
  // crash-recovery tests below can import `sweepDelegationChildren` and have
  // it resolve the exact same tmp registry file this module's own
  // `pathResolver.shared(...)` writes to.
  shared: (sub = '') => path.join(tmpDir, sub),
  sharedTmp: (sub = '') => path.join(tmpDir, 'tmp', sub),
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
    loadJsonIfPresent: () => null,
  };
});

vi.mock('./foundation/json.js', () => ({
  readJson: <T>(filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf8')) as T,
}));

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
  registerKillSwitchTerminationRegistrar,
  peekPersistedDelegationChildrenRegistry,
  getRecordedDelegationTimeouts,
  resetDelegationConcurrencyStateForTests,
  delegationChildHandleFromChildProcess,
  type DelegationChildHandle,
  type DelegationChildRecord,
} from './delegation-concurrency.js';
import {
  sweepDelegationChildren,
  type DelegationChildRecord as JanitorDelegationChildRecord,
} from './storage-janitor.js';

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
    registerKillSwitchTerminationRegistrar((listener) => onKillSwitchTermination(listener));
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

  describe('delegationChildHandleFromChildProcess', () => {
    it('adapts a ChildProcess-shaped object into a DelegationChildHandle (pid passthrough, kill forwarding)', () => {
      const kill = vi.fn(() => true);
      const fakeChildProcess = { pid: 555, kill };
      const handle = delegationChildHandleFromChildProcess(fakeChildProcess);

      expect(handle.pid).toBe(555);
      handle.kill('SIGTERM');
      expect(kill).toHaveBeenCalledWith('SIGTERM');
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

  // XP-06 remainder: the three CLI backends now build their real spawned
  // `ChildProcess` into a handle via `delegationChildHandleFromChildProcess`
  // and wrap the awaited spawn in `withWallClockBudget` (see the module doc
  // header and each backend's own `spawnCli`). These tests exercise that
  // exact pairing — `delegationChildHandleFromChildProcess` feeding a real
  // `withWallClockBudget` call — against a fake async "spawn" (a bare object
  // with `pid`/`kill`, standing in for a `ChildProcess`) rather than
  // importing a real backend module, which would drag in that backend's full
  // production dependency graph (egress policy, audit chain, ...) just to
  // reconstruct what is, underneath, exactly this pairing. Each backend's own
  // test file (`shell-claude-cli-backend.test.ts` etc.) asserts *that* its
  // `spawnCli` calls `withWallClockBudget` with the right provider/budget/
  // child, with `delegation-concurrency.js` mocked; this suite asserts what
  // happens once it's for real.
  describe('fake async spawn wired through delegationChildHandleFromChildProcess (XP-06)', () => {
    function fakeAsyncSpawn(pid: number): { pid: number; kill: ReturnType<typeof vi.fn> } {
      return { pid, kill: vi.fn(() => true) };
    }

    it('registers the fake spawned child (pid/provider/deadline) while running and deregisters it on clean exit', async () => {
      const fakeChild = fakeAsyncSpawn(31337);
      const deferred = makeDeferred<string>();

      const runPromise = withWallClockBudget(
        {
          provider: 'claude',
          budgetMs: 60000,
          child: delegationChildHandleFromChildProcess(fakeChild),
        },
        () => deferred.promise
      );

      await new Promise((r) => setTimeout(r, 0));
      const registry = peekPersistedDelegationChildrenRegistry();
      expect(registry).toHaveLength(1);
      expect(registry[0]).toMatchObject({ provider: 'claude', pid: 31337 });
      expect(Date.parse(registry[0].deadlineAt)).toBeGreaterThan(Date.parse(registry[0].startedAt));

      deferred.resolve('ok');
      await runPromise;
      expect(peekPersistedDelegationChildrenRegistry()).toEqual([]);
    });

    it('SIGTERM then (after the grace window) SIGKILLs the fake spawned child pid on wall-clock expiry', async () => {
      vi.useFakeTimers();
      const fakeChild = fakeAsyncSpawn(42);
      const never = new Promise<string>(() => {});

      const runPromise = withWallClockBudget(
        {
          provider: 'claude',
          budgetMs: 1000,
          killGraceMs: 500,
          child: delegationChildHandleFromChildProcess(fakeChild),
        },
        () => never
      );
      const assertion = expect(runPromise).rejects.toBeInstanceOf(DelegationWallClockExceededError);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(fakeChild.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(500);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
      await assertion;
    });
  });

  // XP-06 remainder: the zombie sweep (`storage-janitor.ts`'s
  // `sweepDelegationChildren`) now has a real producer (the backend
  // integration tests above). `storage-janitor.ts` deliberately duplicates
  // `DelegationChildRecord` rather than importing this module (see its own
  // comment) — these tests keep that duplication honest and prove a record
  // left behind by a crashed run is actually reaped.
  describe('zombie-sweep producer/consumer shape (XP-06)', () => {
    it("shape-drift guard: this module's DelegationChildRecord and storage-janitor.ts's duplicated one declare the same fields", () => {
      const producerRecord: DelegationChildRecord = {
        id: 'shape-check',
        provider: 'claude',
        pid: 123,
        startedAt: new Date().toISOString(),
        deadlineAt: new Date().toISOString(),
        budgetMs: 1000,
      };
      // Compile-time: if either interface gains/loses/renames a field this
      // bidirectional assignment stops type-checking — the cheapest possible
      // drift guard given the two are deliberately not the same imported
      // type (see storage-janitor.ts's comment on why not).
      const asConsumerShape: JanitorDelegationChildRecord = producerRecord;
      const roundTrip: DelegationChildRecord = asConsumerShape;
      expect(roundTrip).toEqual(producerRecord);

      // Runtime: catch a field added to one side with a default that would
      // still satisfy the type checker (e.g. a new optional field) without
      // the other side noticing.
      expect(Object.keys(asConsumerShape).sort()).toEqual(Object.keys(producerRecord).sort());
    });

    it('a record left behind by a crashed run (no in-process SIGKILL escalation ever ran) is visible to and reaped by sweepDelegationChildren', () => {
      const staleRecord: DelegationChildRecord = {
        id: 'crashed-run-1',
        provider: 'codex',
        pid: 9999,
        startedAt: new Date(Date.now() - 120000).toISOString(),
        deadlineAt: new Date(Date.now() - 60000).toISOString(), // budget expired 1min ago
        budgetMs: 60000,
        pidStartedAt: new Date(Date.now() - 120000).toISOString(),
      };
      const registryPath = path.join(tmpDir, 'runtime', 'delegation-children.json');
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(registryPath, JSON.stringify([staleRecord], null, 2));

      const killFn = vi.fn();
      const result = sweepDelegationChildren({
        dryRun: false,
        killFn,
        processStartTimeFn: () => staleRecord.pidStartedAt,
      });

      expect(result.stale).toHaveLength(1);
      expect(result.stale[0]).toMatchObject({ id: 'crashed-run-1', pid: 9999 });
      expect(killFn).toHaveBeenCalledWith(9999, 'SIGKILL');
      expect(result.killed).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(registryPath, 'utf8'))).toEqual([]);
    });
  });
});
