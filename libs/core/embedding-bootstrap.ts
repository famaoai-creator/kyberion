import {
  getEmbeddingBackend,
  registerEmbeddingBackend,
  resetEmbeddingBackend,
} from './embedding-backend.js';
import { MlxEmbeddingBackend, isMlxAvailable } from './mlx-embedding-backend.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { GeminiEmbeddingBackend, isGeminiEmbeddingAvailable } from './gemini-embedding-backend.js';
import { logger } from './core.js';

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

  if (isMlxAvailable()) {
    const mlxBackend = new MlxEmbeddingBackend();
    registerEmbeddingBackend(mlxBackend);
    logger.success(
      `[embedding-bootstrap] Installed real LLM MLX embedding backend (model=${mlxBackend.name})`
    );
    return true;
  }

  // KM-02 Task 3: real embeddings without Apple silicon — the Gemini
  // embedding API slots in between MLX and the degraded hash fallback.
  if (isGeminiEmbeddingAvailable()) {
    const geminiBackend = new GeminiEmbeddingBackend();
    registerEmbeddingBackend(geminiBackend);
    logger.success(
      `[embedding-bootstrap] Installed Gemini embedding backend (model=${geminiBackend.name})`
    );
    return true;
  }

  const backend = getEmbeddingBackend();
  if (!backend) return false;
  registerEmbeddingBackend(backend);
  logger.info(`[embedding-bootstrap] Installed fallback embedding backend: ${backend.name}`);
  return true;
}
