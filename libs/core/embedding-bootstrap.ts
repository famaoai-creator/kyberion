import { getEmbeddingBackend, registerEmbeddingBackend } from './embedding-backend.js';

export function installEmbeddingBackendIfAvailable(): boolean {
  const backend = getEmbeddingBackend();
  if (!backend) return false;
  registerEmbeddingBackend(backend);
  return true;
}
