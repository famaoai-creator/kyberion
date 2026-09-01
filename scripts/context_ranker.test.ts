import { describe, expect, it } from 'vitest';
import { normalizeRankingWeights, type RankingWeights } from './context_ranker.js';

const defaults: RankingWeights = {
  title: 10,
  id: 5,
  tag: 15,
  category: 3,
  role: 25,
  phase: 18,
  scope: 12,
  kind: 10,
  authority: 8,
  proximity: 1,
  usage_yield: 4,
};

describe('context ranker configuration boundary', () => {
  it('projects only finite numeric ranking weights from the governed shape', () => {
    expect(
      normalizeRankingWeights(
        {
          algorithms: {
            ranking: {
              weights: { title: 20, role: 'invalid', tag: Number.POSITIVE_INFINITY },
            },
          },
        },
        defaults
      )
    ).toEqual({ title: 20 });
  });

  it('ignores primitive, array, and incomplete configuration shapes', () => {
    expect(normalizeRankingWeights([], defaults)).toEqual({});
    expect(normalizeRankingWeights('invalid', defaults)).toEqual({});
    expect(normalizeRankingWeights({ algorithms: { ranking: { weights: [] } } }, defaults)).toEqual(
      {}
    );
  });
});
