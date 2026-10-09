import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAllFiles } from './fs-utils.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { coreSeamCatalog } from './seam.js';

/**
 * A module that creates a seam at load time can be evaluated twice against one
 * `coreSeamCatalog` instance: a `vi.resetModules()` racing an in-flight import
 * (operations-hygiene-runbook §5) failed with
 * `Seam task-intent-builder is already registered in the catalog` in round 4.
 *
 * A query-suffixed specifier gives a second, independent evaluation of the
 * defining module while its dependencies (`./seam.js`) stay shared — exactly
 * the shape of that race, without depending on its timing.
 */
async function evaluateAgain(specifier: string, generation: string): Promise<unknown> {
  const url = `${specifier}?reevaluation=${generation}`;
  return import(/* @vite-ignore */ url);
}

describe('module-level seam creation under re-evaluation', () => {
  it('a re-evaluated defining module replaces its own catalog entry', async () => {
    const first =
      (await import('./super-nerve-execution-port.js')) as typeof import('./super-nerve-execution-port.js');
    const before = coreSeamCatalog.get('super-nerve-executor');
    expect(before).toBeDefined();

    const second = (await evaluateAgain(
      './super-nerve-execution-port.ts',
      'a'
    )) as typeof import('./super-nerve-execution-port.js');
    expect(second).not.toBe(first);

    const after = coreSeamCatalog.get('super-nerve-executor');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(coreSeamCatalog.list().filter((b) => b.key === 'super-nerve-executor')).toHaveLength(1);

    // The latest evaluation's API reaches the catalog's seam.
    const dispose = second.registerSuperNerveExecutor(async () => 'fresh');
    try {
      await expect(second.executeRegisteredSuperPipeline([])).resolves.toBe('fresh');
      expect(after!.list().map((provider) => provider.id)).toEqual(['super-nerve']);
    } finally {
      dispose();
    }
  });

  it('task-session survives a second evaluation (the round-4 symptom)', async () => {
    await import('./task/task-session.js');
    const builtins = coreSeamCatalog
      .list()
      .find((binding) => binding.key === 'task-intent-builder')!
      .providers.map((provider) => provider.id);
    expect(builtins.length).toBeGreaterThan(0);

    await expect(evaluateAgain('./task/task-session.ts', 'b')).resolves.toBeDefined();
    const rebound = coreSeamCatalog
      .list()
      .find((binding) => binding.key === 'task-intent-builder')!
      .providers.map((provider) => provider.id);
    // The second evaluation re-registers its builtin builders on its own seam.
    expect(rebound).toEqual(builtins);
  }, 60_000);

  it('every module-level core seam declares its defining module as owner', () => {
    // Without an owner a re-evaluated module throws SEAM_DUPLICATE_PROVIDER;
    // with a copied owner, two different modules could replace each other.
    const root = pathResolver.rootDir();
    const sources = ['libs/core', 'libs/actuators']
      .flatMap((dir) => getAllFiles(path.join(root, dir)))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .filter((rel) => rel.endsWith('.ts') && !rel.endsWith('.d.ts'))
      .filter((rel) => !rel.endsWith('.test.ts') && !rel.includes('/dist/'))
      .filter((rel) => !rel.includes('/node_modules/'));
    const declarations: string[] = [];
    const missing: string[] = [];
    for (const rel of sources) {
      const text = safeReadFile(path.join(root, rel), { encoding: 'utf8' }) as string;
      if (!text.includes('catalog: coreSeamCatalog')) continue;
      for (const match of text.matchAll(/catalog:\s*coreSeamCatalog,?\s*(owner:\s*'([^']*)')?/g)) {
        declarations.push(rel);
        if (match[2] !== rel) missing.push(`${rel}: owner ${match[2] ?? '<none>'}`);
      }
    }
    expect(declarations.length).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  }, 60_000);
});
