import { describe, expect, it, vi } from 'vitest';

const readFileMock = vi.fn();

vi.mock('./secure-io.js', () => ({
  safeReadFile: readFileMock,
}));

vi.mock('./error-classifier.js', () => ({
  classifyError: (error: Error) => ({
    category: /TIMEOUT|ETIMEDOUT/i.test(error.message)
      ? 'timeout'
      : /ENOSPC|resource unavailable/i.test(error.message)
        ? 'resource_unavailable'
        : 'unknown',
  }),
}));

describe('recovery-policy', () => {
  it('preserves defaults and applies manifest plus explicit overrides', async () => {
    readFileMock.mockReturnValue(
      JSON.stringify({
        recovery_policy: {
          retry: { maxRetries: 4, initialDelayMs: 700 },
          retryable_categories: ['timeout'],
        },
      })
    );
    const { buildGovernedRetryOptions } = await import('./recovery-policy.js');
    const options = buildGovernedRetryOptions({
      manifestPath: '/tmp/manifest.json',
      defaults: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 1000, factor: 2, jitter: true },
      override: { maxRetries: 1 },
    });

    expect(options.maxRetries).toBe(1);
    expect(options.initialDelayMs).toBe(700);
    expect(options.shouldRetry?.(new Error('ETIMEDOUT'))).toBe(true);
    expect(options.shouldRetry?.(new Error('invalid input'))).toBe(false);
  });

  it('uses fallback categories when the manifest does not provide an allowlist', async () => {
    readFileMock.mockReturnValue(JSON.stringify({ recovery_policy: {} }));
    const { buildGovernedRetryOptions } = await import('./recovery-policy.js');
    const options = buildGovernedRetryOptions({
      manifestPath: '/tmp/manifest.json',
      defaults: { maxRetries: 1 },
      fallbackCategories: ['resource_unavailable'],
    });

    expect(options.shouldRetry?.(new Error('ENOSPC: resource unavailable'))).toBe(true);
    expect(options.shouldRetry?.(new Error('invalid input'))).toBe(false);
  });
});
