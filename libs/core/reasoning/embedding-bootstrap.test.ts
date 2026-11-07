import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installEmbeddingBackendIfAvailable } from './embedding-bootstrap.js';
import { getEmbeddingBackend, resetEmbeddingBackend } from './embedding-backend.js';
import { isMlxAvailable } from '../provider/mlx-embedding-backend.js';

vi.mock('../provider/mlx-embedding-backend.js', async () => {
  const actual = await vi.importActual<typeof import('../provider/mlx-embedding-backend.js')>(
    '../provider/mlx-embedding-backend.js'
  );
  return {
    ...actual,
    isMlxAvailable: vi.fn(),
  };
});

vi.mock('../provider/gemini-embedding-backend.js', async () => {
  const actual = await vi.importActual<typeof import('../provider/gemini-embedding-backend.js')>(
    '../provider/gemini-embedding-backend.js'
  );
  return { ...actual, isGeminiEmbeddingAvailable: () => false };
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

  describe('saved seam default', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('installs the saved default ahead of the policy chain', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'embedding-backend=local-hash-embedding');
      vi.mocked(isMlxAvailable).mockReturnValue(true);
      expect(installEmbeddingBackendIfAvailable()).toBe(true);
      expect(getEmbeddingBackend()?.name).toBe('local-hash-embedding');
    });

    it('falls back to the policy chain when the saved default is unavailable', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'embedding-backend=gemini');
      vi.mocked(isMlxAvailable).mockReturnValue(true);
      expect(installEmbeddingBackendIfAvailable()).toBe(true);
      expect(getEmbeddingBackend()?.name).toBe('mlx');
    });

    it('still honors the disable flag over a saved default', () => {
      vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'embedding-backend=local-hash-embedding');
      process.env.KYBERION_DISABLE_EMBEDDINGS = '1';
      expect(installEmbeddingBackendIfAvailable()).toBe(false);
    });
  });
});
