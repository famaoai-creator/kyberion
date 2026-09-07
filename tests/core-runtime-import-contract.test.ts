import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExecResultAsync, safeReadFile } from '@agent/core/secure-io';

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

    // ~740 subpaths × one child node each: sequential spawns take ~85s
    // locally and exceed the timeout on shared CI runners. Overlap bounded
    // batches through the governed async exec boundary instead; batches stay
    // sequential so failure order remains deterministic.
    const CONCURRENCY = 8;
    for (let index = 0; index < exportKeys.length; index += CONCURRENCY) {
      const batch = exportKeys.slice(index, index + CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (key) => {
          const specifier = exportKeyToSpecifier(key);
          const result = await safeExecResultAsync(
            'node',
            [
              '--input-type=module',
              '-e',
              `import(${JSON.stringify(specifier)}).then(() => console.log('ok'))`,
            ],
            {
              cwd: process.cwd(),
            }
          );
          if (result.status !== 0 || result.error) {
            return {
              specifier,
              error:
                result.error?.message || result.stderr.slice(0, 300) || `exit ${result.status}`,
            };
          }
          return null;
        })
      );
      for (const failure of settled) {
        if (failure) failures.push(failure);
      }
    }

    expect(failures).toEqual([]);
  }, 180000); // loads every subpath in a child process — slow on shared CI runners
});
