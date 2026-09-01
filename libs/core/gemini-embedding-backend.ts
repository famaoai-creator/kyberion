import { secureFetch } from './network.js';
import { isRecord } from './foundation/text.js';
import type { EmbeddingBackend } from './embedding-backend.js';

/**
 * KM-02 Task 3: a real embedding path that works off-macOS (MLX is
 * Apple-silicon only, and without it retrieval silently degraded to the
 * 64-dim hash backend). Uses the Gemini embedding API when a key is
 * present; requests go through secureFetch, so the egress policy governs
 * the endpoint like any other outbound call.
 */

const DEFAULT_MODEL = 'text-embedding-004';
const DEFAULT_DIMENSIONS = 768;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function resolveGeminiEmbeddingKey(): string | undefined {
  return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined;
}

export function isGeminiEmbeddingAvailable(): boolean {
  return Boolean(resolveGeminiEmbeddingKey());
}

interface GeminiEmbeddingOptions {
  model?: string;
  dimensions?: number;
  /** Injectable transport for tests. */
  fetcher?: typeof secureFetch;
}

interface GeminiEmbeddingResponse {
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}

/** Normalize the embedding payloads consumed from the Gemini API. */
export function normalizeGeminiEmbeddingResponse(value: unknown): GeminiEmbeddingResponse | null {
  if (!isRecord(value)) return null;

  let embedding: GeminiEmbeddingResponse['embedding'];
  if (value.embedding !== undefined) {
    if (!isRecord(value.embedding)) return null;
    const values = normalizeEmbeddingValues(value.embedding.values);
    if (values === null) return null;
    embedding = values === undefined ? {} : { values };
  }

  let embeddings: GeminiEmbeddingResponse['embeddings'];
  if (value.embeddings !== undefined) {
    if (!Array.isArray(value.embeddings)) return null;
    embeddings = [];
    for (const item of value.embeddings) {
      if (!isRecord(item)) return null;
      const values = normalizeEmbeddingValues(item.values);
      if (values === null) return null;
      embeddings.push(values === undefined ? {} : { values });
    }
  }

  if (embedding === undefined && embeddings === undefined) return null;
  return {
    ...(embedding !== undefined ? { embedding } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
  };
}

function normalizeEmbeddingValues(value: unknown): number[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((component) => typeof component !== 'number' || !Number.isFinite(component))
  ) {
    return null;
  }
  return value;
}

export class GeminiEmbeddingBackend implements EmbeddingBackend {
  readonly name: string;
  readonly dimensions: number;
  private readonly model: string;
  private readonly fetcher: typeof secureFetch;

  constructor(options: GeminiEmbeddingOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.name = `gemini:${this.model}`;
    this.fetcher = options.fetcher ?? secureFetch;
  }

  async embed(text: string): Promise<Float32Array> {
    const key = resolveGeminiEmbeddingKey();
    if (!key) throw new Error('[gemini-embedding] no API key available');
    const rawBody = await this.fetcher({
      method: 'POST',
      url: `${API_BASE}/models/${this.model}:embedContent?key=${key}`,
      headers: { 'content-type': 'application/json' },
      data: { content: { parts: [{ text }] } },
      authenticateRequest: true,
      timeout: 20000,
    });
    const body = normalizeGeminiEmbeddingResponse(rawBody);
    if (!body) throw new Error('[gemini-embedding] response had an invalid shape');
    return toVector(body?.embedding?.values, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const key = resolveGeminiEmbeddingKey();
    if (!key) throw new Error('[gemini-embedding] no API key available');
    const rawBody = await this.fetcher({
      method: 'POST',
      url: `${API_BASE}/models/${this.model}:batchEmbedContents?key=${key}`,
      headers: { 'content-type': 'application/json' },
      data: {
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
        })),
      },
      authenticateRequest: true,
      timeout: 30000,
    });
    const body = normalizeGeminiEmbeddingResponse(rawBody);
    if (!body) throw new Error('[gemini-embedding] response had an invalid shape');
    const embeddings = body?.embeddings ?? [];
    return texts.map((_, index) => toVector(embeddings[index]?.values, this.dimensions));
  }
}

function toVector(values: number[] | undefined, dimensions: number): Float32Array {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('[gemini-embedding] response contained no embedding values');
  }
  const vector = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) vector[i] = values[i];
  // Normalize so cosineSimilarity treats all backends uniformly.
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  }
  if (dimensions && values.length !== dimensions) {
    // Dimension drift is tolerated (the API may change) but visible.
    return vector;
  }
  return vector;
}
