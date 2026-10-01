import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_JUDGMENT_PROVIDER,
  listJudgmentBackends,
  registerJudgmentBackend,
  resetJudgmentBackends,
} from './judgment-backend.js';
import {
  ensureJudgmentBackendsRegistered,
  JUDGMENT_ASSISTS_ENV_VAR,
  JUDGMENT_PROVIDERS_ENV_VAR,
  judgmentAssistReady,
  listOptionalJudgmentProviders,
} from './judgment-provider-bootstrap.js';
import { getTaskModelHintAssisted } from '../mission/mission-workitem-dispatch-review.js';

function registeredIds(): string[] {
  return listJudgmentBackends()
    .map((backend) => backend.judgment_id)
    .sort();
}

afterEach(() => {
  resetJudgmentBackends();
  delete process.env[JUDGMENT_PROVIDERS_ENV_VAR];
  delete process.env[JUDGMENT_ASSISTS_ENV_VAR];
});

describe('judgmentAssistReady', () => {
  it('stays false while no provider has a calibration fit, and registers the floor', () => {
    resetJudgmentBackends();
    registerJudgmentBackend({
      judgment_id: 'uncalibrated-test',
      egress: 'local-only',
      supports: () => true,
      async judge() {
        throw new Error('must not be asked');
      },
    });
    expect(judgmentAssistReady('error.category')).toBe(false);
    expect(registeredIds()).toContain(BUILTIN_JUDGMENT_PROVIDER);
  });

  it('is false when the assists are switched off', () => {
    process.env[JUDGMENT_ASSISTS_ENV_VAR] = 'off';
    resetJudgmentBackends();
    expect(judgmentAssistReady('error.category')).toBe(false);
    // Switched off means not even the floor is registered.
    expect(registeredIds()).toEqual([]);
  });
});

describe('ensureJudgmentBackendsRegistered', () => {
  it('registers the built-in floor by default and nothing else', () => {
    resetJudgmentBackends();
    const result = ensureJudgmentBackendsRegistered();
    expect(result).toEqual({ registered: [BUILTIN_JUDGMENT_PROVIDER], refused: [] });
    expect(registeredIds()).toEqual([BUILTIN_JUDGMENT_PROVIDER]);
  });

  it('is idempotent: a second call registers nothing new', () => {
    resetJudgmentBackends();
    ensureJudgmentBackendsRegistered({ providers: 'laya-mlx' });
    const again = ensureJudgmentBackendsRegistered({ providers: 'laya-mlx' });
    expect(again.registered).toEqual([]);
    expect(registeredIds()).toEqual([BUILTIN_JUDGMENT_PROVIDER, 'laya-mlx'].sort());
  });

  it('registers the opt-in providers listed in KYBERION_JUDGMENT_PROVIDERS without contacting them', () => {
    resetJudgmentBackends();
    process.env[JUDGMENT_PROVIDERS_ENV_VAR] = ' laya-mlx , typesafe-jev ';
    const result = ensureJudgmentBackendsRegistered();
    expect(result.registered.sort()).toEqual(
      [BUILTIN_JUDGMENT_PROVIDER, 'laya-mlx', 'typesafe-jev'].sort()
    );
    expect(listOptionalJudgmentProviders().sort()).toEqual(['laya-mlx', 'typesafe-jev']);
  });

  it('refuses an unknown provider id with a reason instead of ignoring it', () => {
    resetJudgmentBackends();
    const result = ensureJudgmentBackendsRegistered({ providers: 'laya-mlx,not-a-provider' });
    expect(result.refused).toEqual([
      { id: 'not-a-provider', reason: expect.stringContaining('unknown judgment provider') },
    ]);
    expect(registeredIds()).toEqual([BUILTIN_JUDGMENT_PROVIDER, 'laya-mlx'].sort());
  });
});

describe('task routing call site', () => {
  it('bootstraps the judgment providers before asking the tier question', async () => {
    resetJudgmentBackends();
    const result = await getTaskModelHintAssisted({
      item_id: 'WI-1',
      title: 'rename a variable',
      description: 'mechanical rename',
      metadata: {},
    } as any);
    expect(result.downgraded).toBe(false);
    expect(registeredIds()).toEqual([BUILTIN_JUDGMENT_PROVIDER]);
  });
});
