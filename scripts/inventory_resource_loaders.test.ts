import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  collectImportedRegularFileHelperNames,
  readResourceLoaderInventoryTextFile,
  scanResourceLoaderSource,
} from './inventory_resource_loaders.js';

describe('resource loader inventory', () => {
  it('rejects a directory before reading a source file', () => {
    expect(() => readResourceLoaderInventoryTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

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

  it('follows a relative regular-file helper import into its implementation', () => {
    const importer = '/repo/libs/consumer.ts';
    const helper = '/repo/libs/resource-guards.ts';
    const sourceByFile = new Map([
      [
        importer,
        [
          "import { assertRegularArtifact as assertArtifact } from './resource-guards.js';",
          'assertArtifact(filePath);',
          'return readJson(filePath);',
        ].join('\n'),
      ],
      [
        helper,
        [
          'export function assertRegularArtifact(filePath: string): void {',
          '  if (!safeStat(filePath).isFile()) throw new Error("not a file");',
          '}',
        ].join('\n'),
      ],
    ]);

    const external = collectImportedRegularFileHelperNames(
      importer,
      sourceByFile.get(importer) ?? '',
      sourceByFile
    );
    expect(external).toEqual(new Set(['assertArtifact']));
    expect(
      scanResourceLoaderSource(importer, sourceByFile.get(importer) ?? '', {
        externalRegularFileHelpers: external,
      })
    ).toEqual([
      {
        file: importer,
        line: 3,
        loader: 'readJson',
        status: 'nearby-path-guard',
        evidence: ['external-regular-file-helper:assertArtifact'],
      },
    ]);
  });

  it('does not follow a relative path-only helper as regular-file evidence', () => {
    const importer = '/repo/libs/consumer.ts';
    const helper = '/repo/libs/resource-guards.ts';
    const sourceByFile = new Map([
      [
        importer,
        [
          "import { safeArtifactPath } from './resource-guards.js';",
          'safeArtifactPath(filePath);',
          'return readJson(filePath);',
        ].join('\n'),
      ],
      [
        helper,
        [
          'export function safeArtifactPath(filePath: string): string {',
          '  return assertSafeRepositoryPath(filePath);',
          '}',
        ].join('\n'),
      ],
    ]);

    expect(
      collectImportedRegularFileHelperNames(
        importer,
        sourceByFile.get(importer) ?? '',
        sourceByFile
      )
    ).toEqual(new Set());
    expect(scanResourceLoaderSource(importer, sourceByFile.get(importer) ?? '')).toEqual([
      {
        file: importer,
        line: 3,
        loader: 'readJson',
        status: 'needs-review',
        evidence: [],
      },
    ]);
  });

  it('follows a relative barrel export to a regular-file helper', () => {
    const importer = '/repo/libs/consumer.ts';
    const barrel = '/repo/libs/resource-guards.ts';
    const helper = '/repo/libs/file-guards.ts';
    const sourceByFile = new Map([
      [
        importer,
        [
          "import { assertRegularArtifact as assertArtifact } from './resource-guards.js';",
          'assertArtifact(filePath);',
          'return readJson(filePath);',
        ].join('\n'),
      ],
      [barrel, "export { assertRegularArtifact } from './file-guards.js';"],
      [
        helper,
        [
          'export function assertRegularArtifact(filePath: string): void {',
          '  if (!safeLstat(filePath).isFile()) throw new Error("not a file");',
          '}',
        ].join('\n'),
      ],
    ]);

    expect(
      collectImportedRegularFileHelperNames(
        importer,
        sourceByFile.get(importer) ?? '',
        sourceByFile
      )
    ).toEqual(new Set(['assertArtifact']));
  });

  it('follows export-star barrels but keeps package imports unclassified', () => {
    const importer = '/repo/libs/consumer.ts';
    const barrel = '/repo/libs/index.ts';
    const helper = '/repo/libs/file-guards.ts';
    const sourceByFile = new Map([
      [
        importer,
        [
          "import { assertRegularArtifact } from './index.js';",
          'assertRegularArtifact(filePath);',
          'return readJson(filePath);',
        ].join('\n'),
      ],
      [barrel, "export * from './file-guards.js';"],
      [
        helper,
        [
          'export function assertRegularArtifact(filePath: string): void {',
          '  if (!safeStat(filePath).isFile()) throw new Error("not a file");',
          '}',
        ].join('\n'),
      ],
    ]);

    expect(
      collectImportedRegularFileHelperNames(
        importer,
        sourceByFile.get(importer) ?? '',
        sourceByFile
      )
    ).toEqual(new Set(['assertRegularArtifact']));
    expect(
      collectImportedRegularFileHelperNames(
        importer,
        "import { safeArtifactPath } from '@agent/core/secure-io';",
        sourceByFile
      )
    ).toEqual(new Set());
  });
});
