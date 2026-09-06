import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readCapabilitySeamsTextFile } from './generate_capability_seams.js';

describe('capability seams generator boundary', () => {
  it('uses the foundation text reader for declaration source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_capability_seams.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).toContain('readCapabilitySeamsTextFile(filePath: string)');
    expect(source).not.toContain('safeReadFile(');
    expect(source).toContain('defineGenerator');
  });

  it('rejects a directory before reading declaration source', () => {
    expect(() => readCapabilitySeamsTextFile(pathResolver.rootResolve('libs'))).toThrow(
      'must be a regular file'
    );
  });
});
