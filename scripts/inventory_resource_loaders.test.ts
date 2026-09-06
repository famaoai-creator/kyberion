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

  it('captures a guard at the start of the same short read section', () => {
    const source = [
      'safeLstat(filePath);',
      ...Array.from({ length: 20 }, () => 'const detail = true;'),
      'return readTextFile(filePath);',
    ].join('\n');

    expect(scanResourceLoaderSource('libs/example.ts', source)).toEqual([
      {
        file: 'libs/example.ts',
        line: 22,
        loader: 'readTextFile',
        status: 'nearby-path-guard',
        evidence: ['safeLstat'],
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

  it('recognizes a local helper only when its body checks regular-file type', () => {
    expect(
      scanResourceLoaderSource(
        'libs/example.ts',
        [
          'function regularArtifactPath(filePath: string): string {',
          '  if (!safeLstat(filePath).isFile()) throw new Error("not a file");',
          '  return filePath;',
          '}',
          'regularArtifactPath(filePath);',
          'return readTextFile(filePath);',
        ].join('\n')
      )
    ).toEqual([
      {
        file: 'libs/example.ts',
        line: 6,
        loader: 'readTextFile',
        status: 'nearby-path-guard',
        evidence: ['safeLstat', 'regular-file-helper:regularArtifactPath'],
      },
    ]);
  });

  it('does not classify path-only helpers as regular-file helpers', () => {
    expect(
      scanResourceLoaderSource(
        'libs/example.ts',
        [
          'function safeArtifactPath(filePath: string): string {',
          '  return assertSafeRepositoryPath(filePath);',
          '}',
          'safeArtifactPath(filePath);',
          'return readTextFile(filePath);',
        ].join('\n')
      )
    ).toEqual([
      {
        file: 'libs/example.ts',
        line: 5,
        loader: 'readTextFile',
        status: 'nearby-path-guard',
        evidence: ['assertSafeRepositoryPath'],
      },
    ]);
  });
});
