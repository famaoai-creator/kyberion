import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installEmbeddingBackendIfAvailable,
} from './embedding-bootstrap.js';
import {
  getEmbeddingBackend,
  resetEmbeddingBackend,
} from './embedding-backend.js';
import { isMlxAvailable } from './mlx-embedding-backend.js';

vi.mock('./mlx-embedding-backend.js', async () => {
  const actual = await vi.importActual<typeof import('./mlx-embedding-backend.js')>('./mlx-embedding-backend.js');
  return {
    ...actual,
    isMlxAvailable: vi.fn(),
  };
});

describe('embedding-bootstrap', () => {
  beforeEach(() => {
    resetEmbeddingBackend();
    vi.clearAllMocks();
    delete process.env.KYBERION_DISABLE_EMBEDDINGS;
  });

  afterEach(() => {
    resetEmbeddingBackend();
    delete process.env.KYBERION_DISABLE_EMBEDDINGS;
  });

  it('installs local-hash-embedding fallback when MLX is not available', () => {
    vi.mocked(isMlxAvailable).mockReturnValue(false);

    const result = installEmbeddingBackendIfAvailable();
    expect(result).toBe(true);

    const backend = getEmbeddingBackend();
    expect(backend).not.toBeNull();
    expect(backend?.name).toBe('local-hash-embedding');
  });

  it('installs MlxEmbeddingBackend when MLX is available', () => {
    vi.mocked(isMlxAvailable).mockReturnValue(true);

    const result = installEmbeddingBackendIfAvailable();
    expect(result).toBe(true);

    const backend = getEmbeddingBackend();
    expect(backend).not.toBeNull();
    expect(backend?.name).toBe('mlx');
  });

  it('does not install any backend if disabled by env var', () => {
    process.env.KYBERION_DISABLE_EMBEDDINGS = '1';
    vi.mocked(isMlxAvailable).mockReturnValue(true);

    const result = installEmbeddingBackendIfAvailable();
    expect(result).toBe(false);

    const backend = getEmbeddingBackend();
    expect(backend).toBeNull();
  });
});
