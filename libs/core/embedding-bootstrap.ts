import { getEmbeddingBackend, registerEmbeddingBackend } from './embedding-backend.js';
import { MlxEmbeddingBackend, isMlxAvailable } from './mlx-embedding-backend.js';
import { GeminiEmbeddingBackend, isGeminiEmbeddingAvailable } from './gemini-embedding-backend.js';
import { logger } from './core.js';

export function installEmbeddingBackendIfAvailable(): boolean {
  if (process.env.KYBERION_DISABLE_EMBEDDINGS === '1') {
    logger.info('[embedding-bootstrap] Embeddings disabled by environment flag');
    return false;
  }

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
