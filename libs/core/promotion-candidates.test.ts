import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const {
  mockAssertSafeRepositoryPath,
  mockReadJson,
  mockSafeExistsSync,
  mockSafeLstat,
  mockSafeMkdir,
  mockSafeWriteFile,
} = vi.hoisted(() => ({
  mockAssertSafeRepositoryPath: vi.fn((filePath: string) => filePath),
  mockReadJson: vi.fn(),
  mockSafeExistsSync: vi.fn(),
  mockSafeLstat: vi.fn(() => ({ isFile: () => true })),
  mockSafeMkdir: vi.fn(),
  mockSafeWriteFile: vi.fn(),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: (filePath: string) => (filePath.startsWith('/') ? filePath : `/repo/${filePath}`),
    shared: (filePath?: string) => `/repo/active/shared${filePath ? `/${filePath}` : ''}`,
    rootDir: () => '/repo',
    knowledge: (filePath?: string) => `/repo/knowledge${filePath ? `/${filePath}` : ''}`,
  },
}));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: mockAssertSafeRepositoryPath,
  safeExistsSync: mockSafeExistsSync,
  safeLstat: mockSafeLstat,
  safeMkdir: mockSafeMkdir,
  safeWriteFile: mockSafeWriteFile,
}));

vi.mock('./foundation/json.js', () => ({
  readJson: <T>(filePath: string) => {
    if (filePath.includes('adhoc-pipeline-run-ledger.schema.json')) {
      return JSON.parse(
        fs.readFileSync(
          path.resolve('knowledge/product/schemas/adhoc-pipeline-run-ledger.schema.json'),
          'utf8'
        )
      ) as T;
    }
    return mockReadJson() as T;
  },
}));

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: <T>(filePath: string) => {
      if (filePath.includes('adhoc-pipeline-run-ledger.schema.json')) {
        return JSON.parse(
          fs.readFileSync(
            path.resolve('knowledge/product/schemas/adhoc-pipeline-run-ledger.schema.json'),
            'utf8'
          )
        ) as T;
      }
      return mockReadJson() as T;
    },
    loadJsonIfPresent: <T>() => mockReadJson() as T,
    appendFile: () => undefined,
    exists: (filePath: string) => mockSafeExistsSync(filePath),
    readFile: () => JSON.stringify(mockReadJson()),
    stat: () => ({ mtimeMs: 0, size: 1 }),
    writeFile: () => undefined,
  }),
}));

import {
  listPromotionCandidates,
  loadAdhocRunLedgerAtPath,
  recordAdhocPipelineRun,
} from './promotion-candidates.js';

describe('promotion-candidates path boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafeLstat.mockReturnValue({ isFile: () => true });
    mockAssertSafeRepositoryPath.mockImplementation((filePath: string) => {
      if (filePath.includes('outside')) {
        throw new Error('[RESOURCE_PATH_SCOPE] resource path is outside the repository root');
      }
      return filePath;
    });
  });

  it('does not record an ad-hoc run for a path outside the repository', () => {
    expect(recordAdhocPipelineRun('../../outside-pipeline.json')).toBe(0);
    expect(mockSafeWriteFile).not.toHaveBeenCalled();
  });

  it('filters repository-external ledger entries before checking their files', () => {
    mockSafeExistsSync.mockReturnValue(true);
    mockReadJson.mockReturnValue([
      { path: 'pipelines/inside.json', count: 3, last_at: '2026-08-31T00:00:00.000Z' },
      { path: '../../outside-pipeline.json', count: 4, last_at: '2026-08-31T00:00:01.000Z' },
    ]);

    expect(listPromotionCandidates()).toEqual([
      { path: 'pipelines/inside.json', count: 3, last_at: '2026-08-31T00:00:00.000Z' },
    ]);
  });

  it('rejects malformed persisted ledger records through the canonical loader', () => {
    mockSafeExistsSync.mockReturnValue(true);
    mockReadJson.mockReturnValue([{ path: 'pipelines/example.json', count: '3', last_at: 'now' }]);

    expect(() => loadAdhocRunLedgerAtPath('/repo/active/shared/ledger.json')).toThrow(
      'Invalid catalog adhoc-pipeline-run-ledger'
    );
  });

  it('rejects a directory at the persisted ledger path', () => {
    mockSafeLstat.mockReturnValue({ isFile: () => false });

    expect(() => loadAdhocRunLedgerAtPath('/repo/active/shared/ledger.json')).toThrow(
      'ledger must be a regular file'
    );
  });
});
