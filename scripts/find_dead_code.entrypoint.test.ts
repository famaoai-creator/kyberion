import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readDeadCodeTextFile } from './find_dead_code.js';

describe('find dead code script boundary', () => {
  it('routes scan progress through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/find_dead_code.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(file');
    expect(source).toContain('run({ print })');
    expect(source).toContain('main(print)');
    expect(source).toContain('readDeadCodeTextFile(filePath: string)');
  });

  it('rejects a directory before reading scanned source', () => {
    expect(() => readDeadCodeTextFile(pathResolver.rootResolve('libs'))).toThrow(
      'must be a regular file'
    );
  });
});
