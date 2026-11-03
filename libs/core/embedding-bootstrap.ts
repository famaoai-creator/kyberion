import {
  EMBEDDING_BACKEND_SEAM,
  getEmbeddingBackend,
  registerEmbeddingBackend,
  resetEmbeddingBackend,
  type EmbeddingBackend,
} from './embedding-backend.js';
import { MlxEmbeddingBackend, isMlxAvailable } from './mlx-embedding-backend.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  GeminiEmbeddingBackend,
  isGeminiEmbeddingAvailable,
} from './provider/gemini-embedding-backend.js';
import { getSeamSelectionPolicy } from './seam-provider-selection.js';
import { logger } from './core.js';

interface EmbeddingCandidate {
  isAvailable(): boolean;
  create(): EmbeddingBackend | null;
}

/**
 * Installable backends keyed by the id the seam policy's `default_chains`
 * orders. `local-hash-embedding` is the always-available degraded backend —
 * `getEmbeddingBackend()` constructs it (or returns a pre-registered custom
 * backend, though bootstrap resets before iterating).
 */
const EMBEDDING_CANDIDATES: Record<string, EmbeddingCandidate> = {
  mlx: { isAvailable: isMlxAvailable, create: () => new MlxEmbeddingBackend() },
  gemini: {
    isAvailable: isGeminiEmbeddingAvailable,
    create: () => new GeminiEmbeddingBackend(),
  },
  'local-hash-embedding': { isAvailable: () => true, create: () => getEmbeddingBackend() },
};

/** Hermetic order when the policy file is absent or unreadable. */
const EMBEDDING_BUILTIN_ORDER = ['mlx', 'gemini', 'local-hash-embedding'] as const;

function candidateOrder(): readonly string[] {
  try {
    const chain = getSeamSelectionPolicy(EMBEDDING_BACKEND_SEAM)?.default_chains?.['default'];
    if (chain?.length) return chain;
  } catch {
    // The policy directory may be absent in isolated test environments;
    // fall through to the builtin ordering.
  }
  return EMBEDDING_BUILTIN_ORDER;
}

export function installEmbeddingBackendIfAvailable(): boolean {
  if (getRegisteredEnvText('KYBERION_DISABLE_EMBEDDINGS') === '1') {
    resetEmbeddingBackend();
    logger.info('[embedding-bootstrap] Embeddings disabled by environment flag');
    return false;
  }

  // Bootstrap owns provider selection. Re-selection is therefore an explicit
  // lifecycle transition; the seam itself still rejects hidden last-wins
  // registration by all other callers.
  resetEmbeddingBackend();

  for (const id of candidateOrder()) {
    const candidate = EMBEDDING_CANDIDATES[id];
    if (!candidate?.isAvailable()) continue;
    const backend = candidate.create();
    if (!backend) continue;
    registerEmbeddingBackend(backend);
    logger.debug(
      `[embedding-bootstrap] Installed embedding backend '${backend.name}' (candidate '${id}')`
    );
    return true;
  }
  return false;
}
