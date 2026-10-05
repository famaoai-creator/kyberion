import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readDesignTokenTextFile, renderUpdatedFile } from './generate_design_tokens.js';
import { safeWriteFile, safeRmSync } from '@agent/core/secure-io';

describe('design token generator boundary', () => {
  it('avoids writes for newline-only drift and preserves CRLF for real changes', () => {
    const file = pathResolver.sharedTmp('design-token-crlf-fixture.css');
    safeWriteFile(file, '.rule {\r\n  display: block;\r\n}\r\n');
    try {
      expect(renderUpdatedFile(file, '.rule {\n  display: block;\n}\n')).toBeUndefined();
      expect(renderUpdatedFile(file, '.rule {\n  display: none;\n}\n')?.content).toBe(
        '.rule {\r\n  display: none;\r\n}\r\n'
      );
    } finally {
      safeRmSync(file, { force: true });
    }
  });
  it('uses the foundation text reader for generated source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_design_tokens.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
    expect(source).toContain('defineGenerator');
  });

  it('rejects a directory replacement before token rendering', () => {
    expect(() => readDesignTokenTextFile(pathResolver.rootDir())).toThrow(
      `${pathResolver.rootDir()} must be a regular file`
    );
  });
});
