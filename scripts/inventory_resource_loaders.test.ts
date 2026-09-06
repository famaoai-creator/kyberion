import { describe, expect, it } from 'vitest';
import { scanResourceLoaderSource } from './inventory_resource_loaders.js';

describe('resource loader inventory', () => {
  it('records inline path validation as the strongest evidence', () => {
    expect(
      scanResourceLoaderSource(
        'libs/example.ts',
        'const value = readJson(assertSafeRepositoryPath(filePath));'
      )
    ).toEqual([
      {
        file: 'libs/example.ts',
        line: 1,
        loader: 'readJson',
        status: 'inline-safe-path',
        evidence: ['assertSafeRepositoryPath'],
      },
    ]);
  });

  it('captures nearby regular-file validation without calling it inline-safe', () => {
    expect(
      scanResourceLoaderSource(
        'libs/example.ts',
        ['assertRegularResource(filePath);', 'return readTextFile(filePath);'].join('\n')
      )
    ).toEqual([
      {
        file: 'libs/example.ts',
        line: 2,
        loader: 'readTextFile',
        status: 'nearby-path-guard',
        evidence: ['assertRegular'],
      },
    ]);
  });

  it('does not mistake loader declarations for resource reads', () => {
    expect(
      scanResourceLoaderSource(
        'libs/example.ts',
        ['function readTextFile(filePath: string) {', '  return filePath;', '}'].join('\n')
      )
    ).toEqual([]);
  });

  it('leaves unclassified reads explicitly reviewable', () => {
    expect(scanResourceLoaderSource('libs/example.ts', 'return readJson(filePath);')).toEqual([
      {
        file: 'libs/example.ts',
        line: 1,
        loader: 'readJson',
        status: 'needs-review',
        evidence: [],
      },
    ]);
  });
});
