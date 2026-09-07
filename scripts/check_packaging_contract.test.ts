import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  findDuplicatePackageExportKeys,
  findMissingPackageExportTargets,
  findUnexportedCoreSubpathImports,
  readPackagingTextFile,
} from './check_packaging_contract.js';

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

  it('detects package export targets missing from the built package', () => {
    expect(
      findMissingPackageExportTargets(
        {
          './one': { types: './dist/one.d.ts', default: './dist/one.js' },
          './two': { types: './dist/two.d.ts' },
        },
        new Set(['./dist/one.d.ts', './dist/two.d.ts'])
      )
    ).toEqual(['./one.default -> ./dist/one.js']);
  });

  it('detects production imports that are absent from the package exports map', () => {
    // Built at runtime, not as a literal package subpath specifier, so the
    // package-boundary-contract scanner does not mistake this fixture data
    // for a real production import.
    const corePackage = ['@agent', 'core'].join('/');
    expect(
      findUnexportedCoreSubpathImports(
        [
          { path: 'satellites/example.ts', source: `import { ok } from '${corePackage}/ok';` },
          {
            path: 'satellites/missing.ts',
            source: `import { missing } from '${corePackage}/missing.js';`,
          },
        ],
        new Set(['./ok'])
      )
    ).toEqual(['./missing <- satellites/missing.ts']);
  });

  it('rejects a directory replacement before packaging policy parsing', () => {
    expect(() => readPackagingTextFile(pathResolver.rootDir(), 'fixture')).toThrow(
      'fixture must be a regular file'
    );
  });
});
