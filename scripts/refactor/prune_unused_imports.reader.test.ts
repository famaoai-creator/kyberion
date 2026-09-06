import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { readPruneUnusedImportsTextFile } from './prune_unused_imports.js';

describe('prune unused imports readers', () => {
  it('uses the foundation text reader for source inspection', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/refactor/prune_unused_imports.ts')
    );

    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('const text = readPruneUnusedImportsTextFile(file)');
    expect(source).not.toContain('safeReadFile');
  });

  it('rejects a directory before reading a source file', () => {
    expect(() => readPruneUnusedImportsTextFile(pathResolver.rootResolve('libs'))).toThrow(
      'must be a regular file'
    );
  });
});
