import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExec, safeReadFile } from '@agent/core/secure-io';

interface CorePackageJson {
  exports: Record<string, { default?: string; types?: string } | string>;
}

function loadCorePackageJson(): CorePackageJson {
  const packagePath = path.join(process.cwd(), 'libs/core/package.json');
  return JSON.parse(safeReadFile(packagePath, { encoding: 'utf8' }) as string) as CorePackageJson;
}

function exportKeyToSpecifier(key: string): string {
  if (key === '.' || key === './index') return '@agent/core';
  return `@agent/core${key.slice(1)}`;
}

describe('Core runtime import contract', () => {
  it('allows every exported @agent/core subpath to load at runtime', async () => {
    const pkg = loadCorePackageJson();
    const exportKeys = Object.keys(pkg.exports)
      .filter((key) => key !== './index')
      .sort((left, right) => left.localeCompare(right));

    const failures: Array<{ specifier: string; error: string }> = [];

    for (const key of exportKeys) {
      const specifier = exportKeyToSpecifier(key);
      try {
        safeExec('node', [
          '--input-type=module',
          '-e',
          `import(${JSON.stringify(specifier)}).then(() => console.log('ok'))`,
        ], {
          cwd: process.cwd(),
        });
      } catch (error: any) {
        failures.push({
          specifier,
          error: error?.message || String(error),
        });
      }
    }

    expect(failures).toEqual([]);
  });
});
