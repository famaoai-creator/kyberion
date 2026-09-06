import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkModuleInvariants, readModuleInvariantTextFile } from './check_module_invariants.js';

describe('module invariant checker', () => {
  it('rejects a directory replacement before invariant parsing', () => {
    expect(() => readModuleInvariantTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for invariant source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_module_invariants.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('validates registered invariants and source assertions', () => {
    expect(checkModuleInvariants().registeredInvariants).toBeGreaterThan(0);
  });
});
