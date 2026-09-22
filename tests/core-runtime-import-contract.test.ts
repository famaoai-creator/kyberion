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

    // ~790 subpaths. One child node per subpath spent most of the time on
    // process start-up and exceeded the timeout on shared CI runners, so
    // each child imports a whole chunk sequentially (every import isolated
    // by its own try/catch) and reports failures as JSON. Chunks run in
    // parallel; results are sorted so the failure list stays deterministic.
    // Trade-off: modules in one chunk share a process, so a subpath that only
    // loads after a sibling has been imported (circular-import TDZ, missing
    // global setup) can be masked; before, every subpath loaded in isolation.
    const CHUNKS = 8;
    const chunkSize = Math.ceil(exportKeys.length / CHUNKS);
    const script = [
      'const specs = JSON.parse(process.argv[1]);',
      'const failed = [];',
      'for (const spec of specs) {',
      "  process.stderr.write('__AT__' + spec + '\\n');",
      '  try { await import(spec); }',
      '  catch (error) { failed.push({ specifier: spec, error: String(error?.stack ?? error).slice(0, 300) }); }',
      '}',
      "process.stdout.write('\\n__RESULT__' + JSON.stringify(failed), () => process.exit(0));",
    ].join('\n');
    const chunks = Array.from({ length: CHUNKS }, (_, i) =>
      exportKeys.slice(i * chunkSize, (i + 1) * chunkSize).map(exportKeyToSpecifier)
    ).filter((chunk) => chunk.length > 0);

    const settled = await Promise.all(
      chunks.map(async (specs) => {
        const result = await safeExecResultAsync(
          'node',
          ['--input-type=module', '-e', script, JSON.stringify(specs)],
          // One timeout per chunk (~100 sequential imports), kept under the test timeout.
          { cwd: process.cwd(), timeoutMs: 150_000 }
        );
        const marker = result.stdout.lastIndexOf('__RESULT__');
        if (result.status !== 0 || result.error || marker < 0) {
          // Blame the subpath that was importing when the child died.
          const lastAt = result.stderr.lastIndexOf('__AT__');
          const culprit = lastAt >= 0 ? result.stderr.slice(lastAt + 6).split('\n')[0] : specs[0];
          return [
            {
              specifier: culprit,
              error: result.error?.message || result.stderr.slice(-300) || `exit ${result.status}`,
            },
          ];
        }
        return JSON.parse(result.stdout.slice(marker + '__RESULT__'.length)) as Array<{
          specifier: string;
          error: string;
        }>;
      })
    );
    for (const chunkFailures of settled) failures.push(...chunkFailures);
    failures.sort((left, right) => left.specifier.localeCompare(right.specifier));

    expect(failures).toEqual([]);
  }, 180000); // loads every subpath in a child process — slow on shared CI runners
});
