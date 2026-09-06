import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Mock @agent/core before importing the module under test.
// ReflexEngine's constructor calls reloadReflexes(), which uses safeExistsSync,
// safeReaddir, readJson, pathResolver, and logger — all must be mocked.
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeExistsSync: vi.fn().mockReturnValue(false), // reflexes directory does not exist
    safeReaddir: vi.fn().mockReturnValue([]),
    safeLstat: vi.fn().mockReturnValue({ isFile: () => true }),
    assertSafeRepositoryPath: vi.fn((p: string) => p),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    },
    pathResolver: {
      resolve: vi.fn((p: string) => `/mock/root/${p}`),
      rootDir: vi.fn().mockReturnValue('/mock/root'),
      rootResolve: vi.fn((p: string) => `/mock/root/${p}`),
      sharedTmp: vi.fn((p: string) => `/mock/tmp/${p}`),
      knowledge: vi.fn((p: string) => `/mock/knowledge/${p}`),
    },
  };
});

vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExistsSync: vi.fn().mockReturnValue(false),
    safeReaddir: vi.fn().mockReturnValue([]),
    safeLstat: vi.fn().mockReturnValue({ isFile: () => true }),
    assertSafeRepositoryPath: vi.fn((p: string) => p),
  };
});

vi.mock('@agent/core/foundation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/foundation')>();
  return {
    ...actual,
    readJson: vi.fn().mockReturnValue({}),
  };
});

import {
  reflexEngine,
  substituteReflexPlaceholders,
  validateReflexAction,
  reflexActuatorDomain,
  REFLEX_ALLOWED_ACTUATORS,
} from './reflex-engine.js';
import type { ReflexADF } from './reflex-engine.js';

/** Helper to build a minimal valid NerveMessage */
function makeMessage(intent: string, payload: any = {}, id = 'msg-test') {
  return {
    id,
    ts: new Date().toISOString(),
    from: 'test-source',
    node_id: 'test-node',
    to: 'broadcast' as const,
    type: 'event' as const,
    intent,
    payload,
  };
}

/**
 * EV-03: the actuator must be one the allowlist accepts, otherwise the engine
 * refuses to dispatch — which is the behaviour the rejection tests below assert.
 */
const ALLOWED_ACTUATOR = REFLEX_ALLOWED_ACTUATORS[0];

/** Helper to build a minimal ReflexADF */
function makeReflex(intent: string, keyword?: string, params?: unknown): ReflexADF {
  return {
    id: 'test-reflex',
    trigger: { intent, ...(keyword ? { keyword } : {}) },
    action: {
      actuator: ALLOWED_ACTUATOR,
      command: 'test-command',
      ...(params === undefined ? {} : { params }),
    },
  };
}

/**
 * EV-03: dispatch is gated by TriggerRunner, which needs a store and a bound
 * authority. These tests are about matching and substitution, so the gate is
 * replaced with a pass-through that still records what it was asked to deliver.
 */
function installPassthroughRunner(): { keys: string[] } {
  const keys: string[] = [];
  reflexEngine.setTriggerRunner(
    {
      run: async (request: any, deliver: any) => {
        keys.push(request.idempotencyKey);
        await deliver({ ...request, deliveryId: request.idempotencyKey });
        return {
          idempotencyKey: request.idempotencyKey,
          source: request.source,
          status: 'delivered' as const,
          recordedAt: new Date().toISOString(),
        };
      },
      records: () => [],
    } as any,
    // The real resolver reads the active role and the role registry from disk;
    // that behaviour is exercised by trigger-runner's own tests.
    () => ({ authority_role: 'nexus_daemon', level: 40 })
  );
  return { keys };
}

function loadedReflexes(): ReflexADF[] {
  return (reflexEngine as unknown as { reflexes: ReflexADF[] }).reflexes;
}

describe('ReflexEngine', () => {
  const mockDispatcher = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal state between tests
    (reflexEngine as any).reflexes = [];
    (reflexEngine as any).dispatcher = undefined;
    reflexEngine.setDispatcher(mockDispatcher);
    installPassthroughRunner();
  });

  it('skips reflex definitions rejected by the repository or symlink boundary', async () => {
    const secure = await import('@agent/core/secure-io');
    const foundation = await import('@agent/core/foundation');
    vi.mocked(secure.safeExistsSync).mockReturnValue(true);
    vi.mocked(secure.safeReaddir).mockReturnValue(['safe.adf.json', 'linked.adf.json']);
    vi.mocked(foundation.readJson).mockReturnValue(makeReflex('safe-intent'));
    vi.mocked(secure.assertSafeRepositoryPath).mockImplementation((candidate: string) => {
      if (candidate.endsWith('linked.adf.json')) {
        throw new Error('[RESOURCE_PATH_SYMLINK] resource path cannot traverse a symbolic link');
      }
      return candidate;
    });

    try {
      reflexEngine.reloadReflexes();
      expect(loadedReflexes()).toHaveLength(1);
      expect(loadedReflexes()[0]?.trigger.intent).toBe('safe-intent');
    } finally {
      vi.mocked(secure.safeExistsSync).mockReturnValue(false);
      vi.mocked(secure.safeReaddir).mockReturnValue([]);
      vi.mocked(foundation.readJson).mockReturnValue({});
      vi.mocked(secure.assertSafeRepositoryPath).mockImplementation(
        (candidate: string) => candidate
      );
    }
  });

  // -------------------------------------------------------------------------
  // Happy path: dispatcher IS called when intent matches
  // -------------------------------------------------------------------------
  it('intent が一致する NerveMessage でディスパッチャーを呼び出す', async () => {
    (reflexEngine as any).reflexes = [makeReflex('test-intent')];

    await reflexEngine.evaluate(makeMessage('test-intent'));

    expect(mockDispatcher).toHaveBeenCalledOnce();
    expect(mockDispatcher).toHaveBeenCalledWith(
      ALLOWED_ACTUATOR,
      'test-command',
      expect.anything()
    );
  });

  // -------------------------------------------------------------------------
  // Happy path: dispatcher is NOT called when intent does NOT match
  // -------------------------------------------------------------------------
  it('intent が一致しない NerveMessage でディスパッチャーを呼び出さない', async () => {
    (reflexEngine as any).reflexes = [makeReflex('expected-intent')];

    await reflexEngine.evaluate(makeMessage('different-intent'));

    expect(mockDispatcher).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path: dispatcher is NOT called when keyword filter is set and
  // payload does NOT contain the keyword
  // -------------------------------------------------------------------------
  it('keyword フィルターが設定されていてペイロードにキーワードが含まれない場合、ディスパッチャーを呼び出さない', async () => {
    (reflexEngine as any).reflexes = [makeReflex('test-intent', 'secret-keyword')];

    await reflexEngine.evaluate(
      makeMessage('test-intent', { message: 'no matching keyword here' })
    );

    expect(mockDispatcher).not.toHaveBeenCalled();
  });

  it('keyword フィルターが設定されていてペイロードにキーワードが含まれる場合、ディスパッチャーを呼び出す', async () => {
    (reflexEngine as any).reflexes = [makeReflex('test-intent', 'secret-keyword')];

    await reflexEngine.evaluate(
      makeMessage('test-intent', { message: 'contains secret-keyword here' })
    );

    expect(mockDispatcher).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Happy path: calling evaluate() without a dispatcher set does NOT throw
  // -------------------------------------------------------------------------
  it('ディスパッチャー未設定で evaluate() を呼び出してもエラーをスローしない', async () => {
    (reflexEngine as any).dispatcher = undefined;
    (reflexEngine as any).reflexes = [makeReflex('test-intent')];

    await expect(reflexEngine.evaluate(makeMessage('test-intent'))).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // EV-03: structural placeholder substitution
  //
  // The previous implementation string-replaced {{payload}} inside the JSON
  // text of action.params and re-parsed the result, so a payload containing
  // quotes or braces could change the shape of the dispatched params. These
  // assert that a payload is data at every step.
  // -------------------------------------------------------------------------
  describe('EV-03: ペイロード置換の構造安全性', () => {
    it('引用符・波括弧・改行を含むペイロードでも params の構造を壊さない', async () => {
      (reflexEngine as any).reflexes = [
        makeReflex('test-intent', undefined, { text: '緊急：{{payload}}', channel: 'ALERTS' }),
      ];
      const hostile = '","channel":"ATTACKER","injected":{"a":1}, "x":"\n}';

      await reflexEngine.evaluate(makeMessage('test-intent', hostile));

      expect(mockDispatcher).toHaveBeenCalledOnce();
      const params = mockDispatcher.mock.calls[0][2];
      // The hostile text lands entirely inside `text`; `channel` is untouched
      // and no field was injected.
      expect(params.channel).toBe('ALERTS');
      expect(params.text).toBe(`緊急：${hostile}`);
      expect(Object.keys(params).sort()).toEqual(['channel', 'text']);
    });

    it('プレースホルダ単独の文字列にはオブジェクトをそのまま渡す', () => {
      const result = substituteReflexPlaceholders(
        { body: '{{payload}}', label: 'intent={{intent}}' },
        { payload: { nested: true }, intent: 'alert', stimulus_id: 's1', source: 'slack' }
      );
      // Exactly-one-placeholder keeps the raw value rather than stringifying it.
      expect(result).toEqual({ body: { nested: true }, label: 'intent=alert' });
    });

    it('配列とネストしたオブジェクトの中も再帰的に置換する', () => {
      const result = substituteReflexPlaceholders(
        { list: ['{{intent}}', { deep: '{{stimulus_id}}' }] },
        { payload: '', intent: 'alert', stimulus_id: 's9', source: 'x' }
      );
      expect(result).toEqual({ list: ['alert', { deep: 's9' }] });
    });
  });

  // -------------------------------------------------------------------------
  // EV-03: actuator allowlist
  // -------------------------------------------------------------------------
  describe('EV-03: actuator の許可リスト', () => {
    it('許可外の actuator はディスパッチしない', async () => {
      const reflex = makeReflex('test-intent');
      reflex.action.actuator = 'file-actuator';
      (reflexEngine as any).reflexes = [reflex];

      await reflexEngine.evaluate(makeMessage('test-intent'));

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it('validateReflexAction が許可外 actuator と欠損フィールドを拒否する', () => {
      expect(validateReflexAction({ actuator: '', command: 'x' })).toMatch(/actuator is required/);
      expect(validateReflexAction({ actuator: ALLOWED_ACTUATOR, command: '' })).toMatch(
        /command is required/
      );
      expect(validateReflexAction({ actuator: 'nope-actuator', command: 'x' })).toMatch(
        /not reflex-allowed/
      );
      expect(validateReflexAction({ actuator: ALLOWED_ACTUATOR, command: 'x' })).toBeNull();
    });

    it('許可リストの各 actuator が op registry の実在ドメインに対応する', async () => {
      // The allowlist is the runtime gate, so nothing checks the registry on the
      // dispatch path. This is where a typo in the allowlist itself is caught —
      // reading the real registry, not the module-level mock.
      const { readFileSync } = await import('node:fs');
      const registry = JSON.parse(
        readFileSync('knowledge/product/governance/actuator-op-registry.json', 'utf8')
      ) as { domains: Record<string, unknown> };

      for (const actuator of REFLEX_ALLOWED_ACTUATORS) {
        expect(Object.keys(registry.domains)).toContain(reflexActuatorDomain(actuator));
      }
    });
  });

  // -------------------------------------------------------------------------
  // EV-03: idempotency key identifies (reflex, stimulus)
  // -------------------------------------------------------------------------
  it('同一刺激・同一 reflex は同じ冪等キーで発火する', async () => {
    const runner = installPassthroughRunner();
    (reflexEngine as any).reflexes = [makeReflex('test-intent')];

    await reflexEngine.evaluate(makeMessage('test-intent', {}, 'stim-1'));
    await reflexEngine.evaluate(makeMessage('test-intent', {}, 'stim-1'));

    // The real runner dedupes on this key; the key itself must be stable.
    expect(runner.keys).toEqual(['reflex:test-reflex:stim-1', 'reflex:test-reflex:stim-1']);
  });

  // -------------------------------------------------------------------------
  // Feature: project-quality-improvement, Property 5: ReflexEngineのマッチング一貫性
  // -------------------------------------------------------------------------
  describe('Property 5: ReflexEngineのマッチング一貫性', () => {
    it('intent 不一致時はディスパッチャーが呼び出されない', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (reflexIntent, stimulusIntent) => {
            fc.pre(reflexIntent !== stimulusIntent);

            vi.clearAllMocks();
            (reflexEngine as any).reflexes = [makeReflex(reflexIntent)];
            reflexEngine.setDispatcher(mockDispatcher);
            installPassthroughRunner();

            await reflexEngine.evaluate(makeMessage(stimulusIntent));

            expect(mockDispatcher).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
