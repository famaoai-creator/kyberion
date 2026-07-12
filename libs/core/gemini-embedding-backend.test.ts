import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiEmbeddingBackend, isGeminiEmbeddingAvailable } from './gemini-embedding-backend.js';

describe('gemini embedding backend (KM-02)', () => {
  const savedGemini = process.env.GEMINI_API_KEY;
  const savedGoogle = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
    if (savedGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = savedGoogle;
  });

  it('reports availability from the key envs', () => {
    expect(isGeminiEmbeddingAvailable()).toBe(true);
    delete process.env.GEMINI_API_KEY;
    expect(isGeminiEmbeddingAvailable()).toBe(false);
    process.env.GOOGLE_API_KEY = 'alt-key';
    expect(isGeminiEmbeddingAvailable()).toBe(true);
  });

  it('embeds a single text and normalizes the vector', async () => {
    const fetcher = vi.fn(async () => ({ embedding: { values: [3, 4] } }));
    const backend = new GeminiEmbeddingBackend({ fetcher: fetcher as never });
    const vector = await backend.embed('hello');
    expect(vector.length).toBe(2);
    expect(vector[0]).toBeCloseTo(0.6);
    expect(vector[1]).toBeCloseTo(0.8);
    const call = fetcher.mock.calls[0][0] as { url: string; data: unknown };
    expect(call.url).toContain(':embedContent');
    expect(JSON.stringify(call.data)).toContain('hello');
  });

  it('embeds batches preserving order', async () => {
    const fetcher = vi.fn(async () => ({
      embeddings: [{ values: [1, 0] }, { values: [0, 1] }],
    }));
    const backend = new GeminiEmbeddingBackend({ fetcher: fetcher as never });
    const vectors = await backend.embedBatch(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(1);
    expect(vectors[1][1]).toBeCloseTo(1);
    const call = fetcher.mock.calls[0][0] as { url: string };
    expect(call.url).toContain(':batchEmbedContents');
  });

  it('fails loudly on empty responses instead of returning junk vectors', async () => {
    const fetcher = vi.fn(async () => ({}));
    const backend = new GeminiEmbeddingBackend({ fetcher: fetcher as never });
    await expect(backend.embed('hello')).rejects.toThrow('no embedding values');
  });
});
