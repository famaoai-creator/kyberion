import { describe, expect, it } from 'vitest';
import { main, parseComparisonCandidates } from './reasoning_compare.js';

describe('reasoning:compare CLI', () => {
  it('prints a dry plan for an instruction', async () => {
    const printed: unknown[] = [];
    await main(['--instruction', 'Summarize the ticket comment.'], (value) => printed.push(value));
    expect(printed[0]).toMatchObject({
      executed: false,
      plan: {
        optimize_for: 'balance',
        admission: { run: false },
      },
    });
  });

  it('parses an explicit backend/model/effort matrix', () => {
    expect(
      parseComparisonCandidates(
        JSON.stringify([
          { backend: 'claude', model: 'opus', effort: 'medium' },
          { backend: 'cursor', model: 'auto' },
        ])
      )
    ).toEqual([
      { provider: 'claude', model: 'opus', effort: 'medium' },
      { provider: 'cursor', model: 'auto' },
    ]);
  });

  it('rejects unknown candidate fields', () => {
    expect(() =>
      parseComparisonCandidates(JSON.stringify([{ backend: 'cursor', surprise: true }]))
    ).toThrow('unknown field');
  });
});
