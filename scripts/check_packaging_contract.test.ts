import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { findDuplicatePackageExportKeys } from './check_packaging_contract.js';

describe('check_packaging_contract', () => {
  it('uses the foundation text reader for packaging inputs', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_packaging_contract.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('detects duplicate package export subpaths before JSON parsing hides them', () => {
    const raw = `{
  "exports": {
    "./one": { "default": "./dist/one.js" },
    "./two": { "default": "./dist/two.js" },
    "./one": { "default": "./dist/one-again.js" }
  }
}`;

    expect(findDuplicatePackageExportKeys(raw)).toEqual(['./one']);
  });

  it('does not treat nested type/default fields as export keys', () => {
    const raw = `{
  "exports": {
    "./one": {
      "types": "./dist/one.d.ts",
      "default": "./dist/one.js"
    }
  }
}`;

    expect(findDuplicatePackageExportKeys(raw)).toEqual([]);
  });
});
