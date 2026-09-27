import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * FU-01: async context of one scenario run.
 *
 * The scenario interceptor binds process-wide seams (op override, risky
 * approval override, preflight capture, fixture reasoning backend). Each of
 * them only acts for calls made inside the matching scope, so unrelated work
 * in a long-running host process never sees scenario fixtures or decisions.
 * Async-local rather than a module flag on purpose: work started outside the
 * run keeps running concurrently while the seams are bound.
 */

interface ScenarioScopeState {
  readonly runId: string;
  /** Set while a fixture handler serves this op (risky approvals key on it). */
  readonly fixtureOp?: string;
}

const scopeStorage = new AsyncLocalStorage<ScenarioScopeState>();

/** Run `fn` (and all async work it starts) inside the scenario scope `runId`. */
export function runInScenarioScope<T>(runId: string, fn: () => T): T {
  if (!runId) throw new Error('[SCENARIO_SCOPE] runId is required');
  return scopeStorage.run({ runId }, fn);
}

export function getActiveScenarioRunId(): string | undefined {
  return scopeStorage.getStore()?.runId;
}

/**
 * Mark `fn` as serving the fixture for `op` within the active scope. Outside
 * a scope `fn` runs unmarked, so the marker can never create a scope.
 */
export function runServingScenarioFixture<T>(op: string, fn: () => T): T {
  const store = scopeStorage.getStore();
  if (!store) return fn();
  return scopeStorage.run({ runId: store.runId, fixtureOp: op }, fn);
}

/** The fixture op being served in the active scope, if any. */
export function getServingScenarioFixtureOp(): string | undefined {
  return scopeStorage.getStore()?.fixtureOp;
}
