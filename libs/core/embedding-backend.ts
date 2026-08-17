import { coreSeamCatalog, defineSeam } from './seam.js';

export interface EmbeddingBackend {
  name: string;
  dimensions?: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

const VECTOR_SIZE = 64;
const embeddingBackendSeam = defineSeam<EmbeddingBackend>({
  key: 'embedding-backend',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});
let registeredBackendDisposer: (() => void) | null = null;

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function embedText(text: string): Float32Array {
  const vector = new Float32Array(VECTOR_SIZE);
  const tokens = normalizeText(text);
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
  if (process.env.KYBERION_DISABLE_EMBEDDINGS === '1') return null;
  return {
    name: 'local-hash-embedding',
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
  registeredBackendDisposer = embeddingBackendSeam.register(backend.name, backend, {
    provenance: 'builtin',
    source: 'embedding-backend',
  });
  return registeredBackendDisposer;
}

export function resetEmbeddingBackend(): void {
  registeredBackendDisposer?.();
  registeredBackendDisposer = null;
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
