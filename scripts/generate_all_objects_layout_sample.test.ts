import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('generate_all_objects_layout_sample entrypoint', () => {
  it('uses the shared script error and output boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_all_objects_layout_sample.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain("import { defineScript, isDirectScript } from './lib/harness.js'");
    expect(source).toContain("name: 'generate:all-objects-layout-sample'");
    expect(source).toContain(
      "isDirectScript(import.meta.url, 'generate_all_objects_layout_sample.js')"
    );
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
    expect(source).not.toContain('process.exitCode');
  });
});
