import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const pathResolverMock = vi.hoisted(() => ({ rootDir: '' }));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => pathResolverMock.rootDir || process.cwd(),
  },
  rootDir: () => pathResolverMock.rootDir || process.cwd(),
  shared: (sub = '') => path.join(pathResolverMock.rootDir || process.cwd(), 'active/shared', sub),
  knowledge: (sub = '') => path.join(process.cwd(), 'knowledge', sub),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    assertSafeRepositoryPath: (filePath: string) => filePath,
    safeExistsSync: (filePath: string) => actual.existsSync(filePath),
    safeLstat: (filePath: string) => actual.lstatSync(filePath),
    safeWriteFile: (filePath: string, content: string) => {
      actual.mkdirSync(path.dirname(filePath), { recursive: true });
      actual.writeFileSync(filePath, content);
    },
  };
});

vi.mock('./foundation/io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    getFoundationIo: () => ({
      loadJson: <T>(filePath: string) => JSON.parse(actual.readFileSync(filePath, 'utf8')) as T,
      loadJsonIfPresent: <T>(filePath: string) => {
        if (!actual.existsSync(filePath)) return null;
        return JSON.parse(actual.readFileSync(filePath, 'utf8')) as T;
      },
      appendFile: (filePath: string, content: string) => actual.appendFileSync(filePath, content),
      exists: (filePath: string) => actual.existsSync(filePath),
      readFile: (filePath: string) => actual.readFileSync(filePath, 'utf8'),
      stat: (filePath: string) => actual.statSync(filePath),
      writeFile: (filePath: string, content: string) => {
        actual.mkdirSync(path.dirname(filePath), { recursive: true });
        actual.writeFileSync(filePath, content);
      },
    }),
  };
});

const { loadBaselineCache, storeBaselineCache } = await import('./baseline-check-cache.js');

describe('baseline-check-cache', () => {
  beforeEach(() => {
    pathResolverMock.rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-baseline-cache-'));
  });

  afterEach(() => {
    fs.rmSync(pathResolverMock.rootDir, { recursive: true, force: true });
    pathResolverMock.rootDir = '';
  });

  it('stores and loads schema-valid tenant drift snapshots', () => {
    const value = {
      timestamp: '2026-09-03T08:00:00.000Z',
      scanned_paths: 0,
      findings: [],
    };

    expect(loadBaselineCache('tenant-drift')).toBeNull();
    storeBaselineCache('tenant-drift', value, 60 * 60 * 1000);

    expect(loadBaselineCache('tenant-drift')).toMatchObject({
      value,
      cached: true,
    });
  });

  it('validates the cowork health value and rejects malformed or non-file state', () => {
    storeBaselineCache(
      'cowork-health',
      {
        healthy: true,
        checks: [{ name: 'mcp_server_built', passed: true }],
        degraded_components: [],
        warnings: [],
      },
      60 * 60 * 1000
    );
    expect(loadBaselineCache('cowork-health')?.cached).toBe(true);

    const cachePath = path.join(
      pathResolverMock.rootDir,
      'active/shared/runtime/baseline-check-cache/cowork-health.json'
    );
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        computed_at: '2026-09-03T08:00:00.000Z',
        ttl_ms: 3600000,
        value: {
          healthy: true,
          checks: [],
          degraded_components: [],
          warnings: [],
          unexpected: true,
        },
      })
    );
    expect(loadBaselineCache('cowork-health')).toBeNull();

    fs.rmSync(cachePath, { force: true });
    fs.mkdirSync(cachePath, { recursive: true });
    expect(loadBaselineCache('cowork-health')).toBeNull();
  });

  it('rejects a non-positive cache TTL at the schema boundary', () => {
    expect(() =>
      storeBaselineCache(
        'tenant-drift',
        { timestamp: '2026-09-03T08:00:00.000Z', scanned_paths: 0, findings: [] },
        -1
      )
    ).toThrow(/Invalid catalog baseline-cache-tenant-drift/);
  });
});
