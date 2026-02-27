import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTreeLinesAsync } from './lib';
import * as fsUtils from '@agent/core/fs-utils';

// Mock the whole module
vi.mock('@agent/core/fs-utils');

describe('buildTreeLinesAsync', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should generate a correct tree structure', async () => {
    const rootDir = '/app';
    const mockFiles = ['/app/README.md', '/app/src/index.ts', '/app/src/utils/helper.ts'];

    // Mock implementation of walkAsync
    vi.mocked(fsUtils.walkAsync).mockImplementation(async function* (_dir, _opts) {
      for (const file of mockFiles) {
        yield file;
      }
    });

    const lines = await buildTreeLinesAsync(rootDir);

    // Expected output order (sorted):
    // ├── README.md
    // └── src
    //     ├── index.ts
    //     └── utils
    //         └── helper.ts

    expect(lines).toContain('├── README.md');
    expect(lines).toContain('└── src');
    expect(lines).toContain('    ├── index.ts');
    expect(lines).toContain('    └── utils');
    expect(lines).toContain('        └── helper.ts');
  });

  it('should handle empty directory', async () => {
    vi.mocked(fsUtils.walkAsync).mockImplementation(async function* () {
      // yield nothing
    });

    const lines = await buildTreeLinesAsync('/empty');
    expect(lines).toEqual(['(No files found)']);
  });
});
