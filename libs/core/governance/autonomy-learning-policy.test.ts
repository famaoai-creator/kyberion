import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadAutonomyLearningPolicy } from './autonomy-learning-policy.js';

const file = pathResolver.sharedTmp('autonomy-learning-policy-tests/policy.json');
const originalKnowledge = pathResolver.knowledge;

afterEach(() => {
  vi.restoreAllMocks();
  safeRmSync(pathResolver.sharedTmp('autonomy-learning-policy-tests'), {
    recursive: true,
    force: true,
  });
});

function useFixture(value?: unknown) {
  if (value !== undefined)
    safeWriteFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  vi.spyOn(pathResolver, 'knowledge').mockImplementation((...args) =>
    args[0] === 'product/governance/autonomy-learning-policy.json'
      ? file
      : originalKnowledge(...args)
  );
}

describe('governed autonomy learning policy', () => {
  it('loads configured windows and thresholds without code changes', () => {
    const base = loadAutonomyLearningPolicy();
    useFixture({
      ...base,
      window_ms: 123456,
      cooldown_ms: 56789,
      notify_min_decisions: 42,
      auto_min_decisions: 84,
    });
    expect(loadAutonomyLearningPolicy()).toMatchObject({
      enabled: true,
      window_ms: 123456,
      cooldown_ms: 56789,
      notify_min_decisions: 42,
    });
  });

  it('rejects a less demanding auto threshold than notify', () => {
    const base = loadAutonomyLearningPolicy();
    useFixture({ ...base, notify_min_decisions: 40, auto_min_decisions: 20 });
    expect(loadAutonomyLearningPolicy().enabled).toBe(false);
  });

  it.each([
    ['malformed', '{broken'],
    ['unknown authority option', { version: '1', enabled: true, allow_all: true }],
    ['invalid threshold', { version: '1', enabled: true, window_ms: -1 }],
    ['missing', undefined],
  ])('disables relaxation for %s configuration', (_label, value) => {
    useFixture(value);
    expect(loadAutonomyLearningPolicy().enabled).toBe(false);
  });
});
