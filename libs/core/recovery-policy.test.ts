import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

const loadJsonMock = vi.fn();
const manifestMock = vi.fn();
const existsMock = vi.fn(() => true);
const statMock = vi.fn(() => ({ mtimeMs: 1, size: 1 }));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  loadJsonMock.mockImplementation((filePath: string) => {
    if (filePath.endsWith('knowledge/product/schemas/actuator-manifest.schema.json')) {
      return actual.loadJson(filePath);
    }
    return manifestMock();
  });
  return {
    ...actual,
    loadJson: loadJsonMock,
    safeExistsSync: existsMock,
    safeStat: statMock,
  };
});

vi.mock('./foundation/json.js', async () => {
  const actual =
    await vi.importActual<typeof import('./foundation/json.js')>('./foundation/json.js');
  return {
    ...actual,
    readJson: <T>(filePath: string): T => {
      if (filePath.endsWith('knowledge/product/schemas/actuator-manifest.schema.json')) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
      }
      return manifestMock() as T;
    },
    readJsonIfPresent: <T>(filePath: string): T | null => {
      try {
        return filePath.endsWith('knowledge/product/schemas/actuator-manifest.schema.json')
          ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as T)
          : (manifestMock() as T);
      } catch {
        return null;
      }
    },
  };
});

// recovery-policy now loads manifests through governed-catalog, whose
// existence/stat checks are intentionally mediated by FoundationIo. Keep the
// fixture seam at that boundary instead of intercepting the old secure-io
// loader only.
vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: <T>(filePath: string): T => loadJsonMock(filePath) as T,
    loadJsonIfPresent: <T>(filePath: string): T | null => loadJsonMock(filePath) as T | null,
    appendFile: vi.fn(),
    exists: () => true,
    readFile: () => '',
    stat: () => ({ mtimeMs: 1, size: 1 }),
    writeFile: vi.fn(),
  }),
  registerFoundationIo: vi.fn(),
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
    manifestMock.mockReturnValue({
      actuator_id: 'test-actuator',
      version: '1.0.0',
      capabilities: [],
      recovery_policy: {
        retry: { maxRetries: 4, initialDelayMs: 700 },
        retryable_categories: ['timeout'],
      },
    });
    const { buildGovernedRetryOptions } = await import('./recovery-policy.js');
    const options = buildGovernedRetryOptions({
      manifestPath: '/tmp/manifest-first.json',
      defaults: { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 1000, factor: 2, jitter: true },
      override: { maxRetries: 1 },
    });

    expect(options.maxRetries).toBe(1);
    expect(options.initialDelayMs).toBe(700);
    expect(options.shouldRetry?.(new Error('ETIMEDOUT'))).toBe(true);
    expect(options.shouldRetry?.(new Error('invalid input'))).toBe(false);
  });

  it('uses fallback categories when the manifest does not provide an allowlist', async () => {
    manifestMock.mockReturnValue({
      actuator_id: 'test-actuator',
      version: '1.0.0',
      capabilities: [],
      recovery_policy: {},
    });
    const { buildGovernedRetryOptions } = await import('./recovery-policy.js');
    const options = buildGovernedRetryOptions({
      manifestPath: '/tmp/manifest-second.json',
      defaults: { maxRetries: 1 },
      fallbackCategories: ['resource_unavailable'],
    });

    expect(options.shouldRetry?.(new Error('ENOSPC: resource unavailable'))).toBe(true);
    expect(options.shouldRetry?.(new Error('invalid input'))).toBe(false);
  });
});
