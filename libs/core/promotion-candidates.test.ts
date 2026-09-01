import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAssertSafeRepositoryPath,
  mockReadJson,
  mockSafeExistsSync,
  mockSafeMkdir,
  mockSafeWriteFile,
} = vi.hoisted(() => ({
  mockAssertSafeRepositoryPath: vi.fn((filePath: string) => filePath),
  mockReadJson: vi.fn(),
  mockSafeExistsSync: vi.fn(),
  mockSafeMkdir: vi.fn(),
  mockSafeWriteFile: vi.fn(),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: (filePath: string) => (filePath.startsWith('/') ? filePath : `/repo/${filePath}`),
    shared: (filePath?: string) => `/repo/active/shared${filePath ? `/${filePath}` : ''}`,
    rootDir: () => '/repo',
  },
}));

vi.mock('./secure-io.js', () => ({
  assertSafeRepositoryPath: mockAssertSafeRepositoryPath,
  safeExistsSync: mockSafeExistsSync,
  safeMkdir: mockSafeMkdir,
  safeWriteFile: mockSafeWriteFile,
}));

vi.mock('./foundation/json.js', () => ({
  readJson: mockReadJson,
}));

import { listPromotionCandidates, recordAdhocPipelineRun } from './promotion-candidates.js';

describe('promotion-candidates path boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
