import {
  EMBEDDING_BACKEND_SEAM,
  getEmbeddingBackend,
  registerEmbeddingBackend,
  resetEmbeddingBackend,
  type EmbeddingBackend,
} from './embedding-backend.js';
import { MlxEmbeddingBackend, isMlxAvailable } from '../provider/mlx-embedding-backend.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import {
  GeminiEmbeddingBackend,
  isGeminiEmbeddingAvailable,
} from '../provider/gemini-embedding-backend.js';
import { resolveSeamDefaultOrder } from '../provider/seam-provider-selection.js';
import {
  unmetRuntimeRequirements,
  type ProviderRuntimeRequirement,
} from '../provider/provider-runtime-requirements.js';
import { logger } from '../core.js';

interface EmbeddingCandidate {
  isAvailable(): boolean;
  create(): EmbeddingBackend | null;
  /** Declarative host requirements; the isAvailable probe stays authoritative. */
  runtime_requirements?: ProviderRuntimeRequirement;
}

/**
 * Installable backends keyed by the id the seam policy's `default_chains`
 * orders. `local-hash-embedding` is the always-available degraded backend —
 * `getEmbeddingBackend()` constructs it (or returns a pre-registered custom
 * backend, though bootstrap resets before iterating).
 */
const EMBEDDING_CANDIDATES: Record<string, EmbeddingCandidate> = {
  mlx: {
    isAvailable: isMlxAvailable,
    create: () => new MlxEmbeddingBackend(),
    // isMlxAvailable = isMacOS && mlx_embed.py present (repo-constant) → the
    // declarative mirror is a darwin-only host requirement.
    runtime_requirements: { platforms: ['darwin'] },
  },
  gemini: {
    isAvailable: isGeminiEmbeddingAvailable,
    create: () => new GeminiEmbeddingBackend(),
    // Credential-bound (tenant credential binding, not a plain env var) —
    // the probe stays the only honest availability signal.
  },
  'local-hash-embedding': { isAvailable: () => true, create: () => getEmbeddingBackend() },
};

/**
 * Selection candidates (id, eligible, unmet) for diagnosis — runtime
 * requirements first, the candidate's own availability probe second.
 */
export function listEmbeddingBackendCandidates(): Array<{
  id: string;
  eligible: boolean;
  unmet: string[];
}> {
  return Object.entries(EMBEDDING_CANDIDATES).map(([id, candidate]) => {
    const unmet = unmetRuntimeRequirements(candidate.runtime_requirements);
    if (unmet.length === 0 && !candidate.isAvailable()) unmet.push('unavailable');
    return { id, eligible: unmet.length === 0, unmet };
  });
}

/** Hermetic order when the policy file is absent or unreadable. */
const EMBEDDING_BUILTIN_ORDER = ['mlx', 'gemini', 'local-hash-embedding'] as const;

/** Saved seam default first, then the policy's default chain (builtin when no policy). */
function candidateOrder(): readonly string[] {
  return resolveSeamDefaultOrder(EMBEDDING_BACKEND_SEAM, { builtin: EMBEDDING_BUILTIN_ORDER });
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
    if (!candidate?.isAvailable()) {
      const unmet = candidate ? unmetRuntimeRequirements(candidate.runtime_requirements) : [];
      if (candidate && unmet.length > 0) {
        logger.debug(
          `[embedding-bootstrap] skipped candidate '${id}' — unmet: ${unmet.join(', ')}`
        );
      }
      continue;
    }
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
