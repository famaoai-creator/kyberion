import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// Mock @agent/core before importing the module under test.
// ReflexEngine's constructor calls reloadReflexes(), which uses safeExistsSync,
// safeReaddir, safeReadFile, pathResolver, and logger — all must be mocked.
vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    safeExistsSync: vi.fn().mockReturnValue(false), // reflexes directory does not exist
    safeReaddir: vi.fn().mockReturnValue([]),
    safeReadFile: vi.fn().mockReturnValue('{}'),
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

import { reflexEngine } from './reflex-engine.js';
import type { ReflexADF } from './reflex-engine.js';

/** Helper to build a minimal valid NerveMessage */
function makeMessage(intent: string, payload: any = {}) {
  return {
    id: 'msg-test',
    ts: new Date().toISOString(),
    from: 'test-source',
    node_id: 'test-node',
    to: 'broadcast' as const,
    type: 'event' as const,
    intent,
    payload,
  };
}

/** Helper to build a minimal ReflexADF */
function makeReflex(intent: string, keyword?: string): ReflexADF {
  return {
    id: 'test-reflex',
    trigger: { intent, ...(keyword ? { keyword } : {}) },
    action: { actuator: 'test-actuator', command: 'test-command' },
  };
}

describe('ReflexEngine', () => {
  const mockDispatcher = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal state between tests
    (reflexEngine as any).reflexes = [];
    (reflexEngine as any).dispatcher = undefined;
    reflexEngine.setDispatcher(mockDispatcher);
  });

  // -------------------------------------------------------------------------
  // Happy path: dispatcher IS called when intent matches
  // -------------------------------------------------------------------------
  it('intent が一致する NerveMessage でディスパッチャーを呼び出す', async () => {
    (reflexEngine as any).reflexes = [makeReflex('test-intent')];

    await reflexEngine.evaluate(makeMessage('test-intent'));

    expect(mockDispatcher).toHaveBeenCalledOnce();
    expect(mockDispatcher).toHaveBeenCalledWith('test-actuator', 'test-command', expect.anything());
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

            await reflexEngine.evaluate(makeMessage(stimulusIntent));

            expect(mockDispatcher).not.toHaveBeenCalled();
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
