import { coreSeamCatalog, createSeam, createSeamLifecycle } from '../seam.js';
import { segmentKeywordTerms } from '../foundation/locale-normalize.js';

export interface EmbeddingBackend {
  name: string;
  dimensions?: number;
  quality?: 'semantic' | 'approximate' | 'unknown';
  qualityNote?: string;
  /**
   * Identity of the vector space for persisted caches (knowledge-index disk
   * cache). Defaults to `name`; bump it whenever the embedding function
   * changes so vectors from the old function are never compared with new ones.
   */
  cacheKey?: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export const EMBEDDING_BACKEND_SEAM = 'embedding-backend';

const VECTOR_SIZE = 64;
const embeddingBackendSeam = createSeam<EmbeddingBackend>({
  key: EMBEDDING_BACKEND_SEAM,
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
  owner: 'libs/core/reasoning/embedding-backend.ts',
});
const embeddingBackendLifecycle = createSeamLifecycle(embeddingBackendSeam);

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const HAN_CHAR = /\p{Script=Han}/u;

/**
 * Hash-embedding tokens. Locale-aware: a spaceless Japanese / Chinese run is
 * segmented into content words with the shared ICU segmenter
 * (`segmentKeywordTerms`) instead of hashing the whole sentence as one token,
 * which made every Japanese text orthogonal to every other. Single kanji are
 * meaningful and kept; other one-character tokens are dropped as before.
 */
function normalizeEmbeddingText(text: string): string[] {
  return segmentKeywordTerms(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')).filter(
    (token) => token.length > 1 || HAN_CHAR.test(token)
  );
}

/** Bumped when `normalizeEmbeddingText` / `embedText` change (cache identity). */
export const LOCAL_HASH_EMBEDDING_CACHE_KEY = 'local-hash-embedding@2';

function embedText(text: string): Float32Array {
  const vector = new Float32Array(VECTOR_SIZE);
  const tokens = normalizeEmbeddingText(text);
  if (tokens.length === 0) return vector;

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % VECTOR_SIZE;
    const weight = 1 + (hash % 7);
    vector[index] += weight;
  }

  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) {
      vector[i] /= norm;
    }
  }
  return vector;
}

export function getEmbeddingBackend(): EmbeddingBackend | null {
  const registeredBackend = embeddingBackendSeam.getOptional();
  if (registeredBackend) return registeredBackend;
  if (getRegisteredEnvText('KYBERION_DISABLE_EMBEDDINGS') === '1') return null;
  return {
    name: 'local-hash-embedding',
    quality: 'approximate',
    qualityNote: 'hash-bucket approximation; not real semantic embeddings',
    cacheKey: LOCAL_HASH_EMBEDDING_CACHE_KEY,
    async embed(text: string): Promise<Float32Array> {
      return embedText(text);
    },
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      return texts.map(embedText);
    },
  };
}

export function registerEmbeddingBackend(backend: EmbeddingBackend): () => void;
/** @deprecated Pass null only for compatibility with legacy reset callers. */
export function registerEmbeddingBackend(backend: null): () => void;
export function registerEmbeddingBackend(backend: EmbeddingBackend | null): () => void {
  if (backend === null) {
    resetEmbeddingBackend();
    return () => undefined;
  }
  if (!backend || typeof backend.name !== 'string' || !backend.name.trim()) {
    throw new TypeError('Embedding backend must have a non-empty name');
  }
  return embeddingBackendLifecycle.register(backend.name, backend, {
    provenance: 'builtin',
    source: 'embedding-backend',
  });
}

export function resetEmbeddingBackend(): void {
  embeddingBackendLifecycle.reset();
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function reciprocalRankFusion(
  rankedLists: Array<Array<{ path: string }>>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const score = 1 / (k + index + 1);
      scores.set(item.path, (scores.get(item.path) || 0) + score);
    });
  }
  return scores;
}
import { getRegisteredEnvText } from '../foundation/env.js';
