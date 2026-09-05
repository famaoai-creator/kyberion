import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';

describe('prune unused imports readers', () => {
  it('uses the foundation text reader for source inspection', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/refactor/prune_unused_imports.ts')
    );

    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('const text = readTextFile(file)');
    expect(source).not.toContain('safeReadFile');
  });
});
