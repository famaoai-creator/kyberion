import { describe, expect, it } from 'vitest';
import {
  getActiveScenarioRunId,
  getServingScenarioFixtureOp,
  runInScenarioScope,
  runServingScenarioFixture,
} from './scenario-run-scope.js';

describe('scenario run scope (FU-01)', () => {
  it('is visible across awaits inside the scope and absent outside it', async () => {
    expect(getActiveScenarioRunId()).toBeUndefined();
    const seen = await runInScenarioScope('run-1', async () => {
      await Promise.resolve();
      const nested = await new Promise<string | undefined>((resolve) =>
        setImmediate(() => resolve(getActiveScenarioRunId()))
      );
      return [getActiveScenarioRunId(), nested];
    });
    expect(seen).toEqual(['run-1', 'run-1']);
    expect(getActiveScenarioRunId()).toBeUndefined();
    expect(() => runInScenarioScope('', () => undefined)).toThrow('[SCENARIO_SCOPE]');
  });

  it('marks fixture serving only inside a scope and only for the wrapped work', async () => {
    expect(runServingScenarioFixture('a:b', () => getServingScenarioFixtureOp())).toBeUndefined();
    await runInScenarioScope('run-1', async () => {
      expect(getServingScenarioFixtureOp()).toBeUndefined();
      const marked = await runServingScenarioFixture('a:b', async () => {
        await Promise.resolve();
        return [getActiveScenarioRunId(), getServingScenarioFixtureOp()];
      });
      expect(marked).toEqual(['run-1', 'a:b']);
      expect(getServingScenarioFixtureOp()).toBeUndefined();
    });
  });
});
