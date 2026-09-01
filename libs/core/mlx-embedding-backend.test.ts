import { describe, expect, it } from 'vitest';
import { normalizeMlxEmbeddingResponse } from './mlx-embedding-backend.js';

describe('MLX embedding subprocess response', () => {
  it('accepts finite numeric vectors and string errors', () => {
    expect(
      normalizeMlxEmbeddingResponse({
        vectors: [
          [0.1, -0.2],
          [1, 0],
        ],
      })
    ).toEqual({
      vectors: [
        [0.1, -0.2],
        [1, 0],
      ],
    });
    expect(normalizeMlxEmbeddingResponse({ error: 'model unavailable' })).toEqual({
      error: 'model unavailable',
    });
  });

  it('rejects malformed vectors and response roots', () => {
    expect(normalizeMlxEmbeddingResponse(null)).toBeNull();
    expect(normalizeMlxEmbeddingResponse([])).toBeNull();
    expect(normalizeMlxEmbeddingResponse({})).toBeNull();
    expect(normalizeMlxEmbeddingResponse({ vectors: { values: [1] } })).toBeNull();
    expect(normalizeMlxEmbeddingResponse({ vectors: [[1, '0']] })).toBeNull();
    expect(normalizeMlxEmbeddingResponse({ vectors: [[Number.NaN]] })).toBeNull();
    expect(normalizeMlxEmbeddingResponse({ vectors: [[Number.POSITIVE_INFINITY]] })).toBeNull();
    expect(normalizeMlxEmbeddingResponse({ error: 500 })).toBeNull();
  });
});
