import { afterAll, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => {
  const previous = process.env.KYBERION_ALLOW_UNSAFE_JS;
  // ALLOW_UNSAFE_JS is read once at module load, so opt in before import.
  process.env.KYBERION_ALLOW_UNSAFE_JS = 'true';
  return previous;
});

import { executePipeline } from './code-pipeline-helpers.js';

afterAll(() => {
  if (saved === undefined) delete process.env.KYBERION_ALLOW_UNSAFE_JS;
  else process.env.KYBERION_ALLOW_UNSAFE_JS = saved;
});

describe('code:run_js transform op', () => {
  it('runs the snippet in a VM sandbox and returns the sandbox ctx', async () => {
    const result = await executePipeline(
      [
        {
          type: 'transform',
          op: 'run_js',
          params: { code: 'ctx.answer = ctx.base + 2;' },
        },
      ] as Parameters<typeof executePipeline>[0],
      { base: 40 }
    );

    expect(result.context.answer).toBe(42);
    expect(result.context.base).toBe(40);
  });
});
