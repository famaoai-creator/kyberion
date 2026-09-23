import { describe, expect, it, vi } from 'vitest';
import { getScenarioOpOverride } from './actuator-op-registry.js';
import { getClock, systemClock } from './foundation/clock.js';
import { parseScenarioDefinition } from './scenario-definition.js';
import { runScenario } from './scenario-executor.js';
import { safeExistsSync } from './secure-io.js';

vi.mock('./scenario-interceptor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scenario-interceptor.js')>();
  return {
    ...actual,
    installScenarioInterceptor: (...args: Parameters<typeof actual.installScenarioInterceptor>) => {
      const interceptor = actual.installScenarioInterceptor(...args);
      return {
        ...interceptor,
        dispose() {
          interceptor.dispose();
          throw new Error('interceptor dispose failed');
        },
      };
    },
  };
});

describe('runScenario teardown (ES-05)', () => {
  it('still restores the clock and removes the run root when interceptor dispose throws', async () => {
    const def = parseScenarioDefinition({
      schema_version: 'kyberion-scenario.v1',
      id: 'executor-dispose-fixture',
      title: 'Executor dispose fixture',
      tier: 1,
      lane: 'pr-deterministic',
      executionProfile: 'simulated',
      modelFixtures: 'model-free',
      requires: {},
      seed: { clock: { start_iso: '2024-05-01T00:00:00.000Z' } },
      fixtures: { ops: {} },
      turns: [{ kind: 'advance_clock', ms: 10 }],
      finalChecks: [],
    });
    let runRoot = '';
    await expect(
      runScenario(def, {
        seedNonce: `dispose-${process.pid}`,
        onRunRoot: (value) => {
          runRoot = value;
        },
      })
    ).rejects.toThrow('interceptor dispose failed');
    expect(getClock()).toBe(systemClock);
    expect(getScenarioOpOverride()).toBeUndefined();
    expect(runRoot).not.toBe('');
    expect(safeExistsSync(runRoot)).toBe(false);
  });
});
