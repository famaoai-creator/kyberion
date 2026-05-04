import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: mockQuestion,
    close: mockClose,
  }),
}));

vi.mock('@agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
    metrics: { recordIntervention: vi.fn() },
  };
});

// chalk mock: returns a proxy that handles chained calls like chalk.italic.yellow(s)
vi.mock('chalk', () => {
  function makeProxy(): any {
    const fn: any = (s: unknown) => String(s ?? '');
    return new Proxy(fn, {
      get(_target, _prop) {
        return makeProxy();
      },
      apply(_target, _thisArg, args) {
        return String(args[0] ?? '');
      },
    });
  }
  return { default: makeProxy() };
});

describe('consultVision()', () => {
  const options = [
    { id: 'opt-a', description: 'Option A', logic_score: 0.8 },
    { id: 'opt-b', description: 'Option B', logic_score: 0.6 },
    { id: 'opt-c', description: 'Option C', logic_score: 0.7 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('数値インデックスで選択した場合、対応するオプションを返す', async () => {
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => cb('1'));

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[0]);
  });

  it('IDで選択した場合、対応するオプションを返す', async () => {
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => cb('opt-b'));

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[1]);
  });

  it('無効な選択の後に有効な選択をした場合、正しいオプションを返す', async () => {
    let callCount = 0;
    mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => {
      callCount++;
      cb(callCount === 1 ? 'invalid' : '2');
    });

    const { consultVision } = await import('./vision-judge.js');
    const result = await consultVision('test context', options);
    expect(result).toEqual(options[1]);
  });

  // Feature: project-quality-improvement, Property 7: consultVisionの選択一貫性
  describe('Property 7: consultVisionの選択一貫性', () => {
    it('任意の有効なオプション配列とインデックスに対して、対応するオプションを返す', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              id: fc.string({ minLength: 1, maxLength: 20 }),
              description: fc.string(),
              logic_score: fc.float({ min: 0, max: 1 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          fc.nat(),
          async (opts, rawIndex) => {
            // 有効なインデックスに正規化する（0 ≤ i < opts.length）
            const index = rawIndex % opts.length;

            vi.clearAllMocks();

            // 1-based の数値インデックスで選択をシミュレート
            mockQuestion.mockImplementation((_: string, cb: (a: string) => void) => {
              cb(String(index + 1));
            });

            const { consultVision } = await import('./vision-judge.js');
            const result = await consultVision('property-test context', opts);

            expect(result).toEqual(opts[index]);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
