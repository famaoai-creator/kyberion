import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_HASH_EMBEDDING_CACHE_KEY,
  cosineSimilarity,
  getEmbeddingBackend,
  resetEmbeddingBackend,
} from './embedding-backend.js';

describe('local hash embedding', () => {
  afterEach(() => resetEmbeddingBackend());

  function localBackend() {
    resetEmbeddingBackend();
    const backend = getEmbeddingBackend();
    if (!backend || backend.name !== 'local-hash-embedding') {
      throw new Error('expected the built-in local hash embedding backend');
    }
    return backend;
  }

  it('places related Japanese texts closer than unrelated ones', async () => {
    // Whitespace tokenization hashed each Japanese sentence as ONE token, so
    // two related sentences were orthogonal (similarity 0) unless they
    // happened to collide in a bucket.
    const backend = localBackend();
    const [query, related, unrelated] = await backend.embedBatch([
      '請求書を作成して送信する',
      '請求書の作成手順',
      '明日の天気予報',
    ]);
    const relatedScore = cosineSimilarity(query, related);
    expect(relatedScore).toBeGreaterThan(0.3);
    expect(relatedScore).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it('keeps English tokenization unchanged and names its vector space for caches', async () => {
    const backend = localBackend();
    expect(backend.cacheKey).toBe(LOCAL_HASH_EMBEDDING_CACHE_KEY);
    const [a, b] = await backend.embedBatch(['deploy the service', 'Deploy, the service!']);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});
