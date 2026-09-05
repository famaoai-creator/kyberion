import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  normalizeMlxEmbeddingResponse,
  probeMlxEmbeddingBackend,
} from './mlx-embedding-backend.js';

describe('MLX embedding subprocess response', () => {
  it('routes the model environment read through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/mlx-embedding-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('uses an injected model in the availability probe', () => {
    expect(probeMlxEmbeddingBackend({ KYBERION_MLX_EMBED_MODEL: 'mlx-test-model' }).model).toBe(
      'mlx-test-model'
    );
  });

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
