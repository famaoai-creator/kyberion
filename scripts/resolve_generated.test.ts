import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { setProcessExitCode } from './lib/harness.js';
import {
  DRIVER_HINT,
  GENERATED_ARTIFACT_STEPS,
  PRE_PUSH_SKIP_ENV,
  RESOLVE_GENERATED_COMMAND,
  formatResolveFailure,
  isTrackedOutput,
  resolveGeneratedArtifacts,
  toRepoRelative,
  trackedGeneratorPaths,
  unmergedGeneratedPaths,
  validateStepOrder,
  type GeneratedArtifactStep,
} from './resolve_generated.js';

const ROOT = '/repo';

function readRepoText(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

function step(
  id: string,
  calls: string[][],
  options: { exitCode?: number; result?: unknown; tracked?: string[] } = {}
): GeneratedArtifactStep {
  return {
    id,
    script: `scripts/${id}.ts`,
    tracked: options.tracked ?? [`${id}.out`],
    run: async (argv) => {
      calls.push([id, ...argv]);
      if (options.exitCode !== undefined) setProcessExitCode(options.exitCode);
      return options.result;
    },
  };
}

describe('resolve_generated catalog', () => {
  it('declares a sound dependency order', () => {
    expect(validateStepOrder(GENERATED_ARTIFACT_STEPS)).toEqual([]);
    const ids = GENERATED_ARTIFACT_STEPS.map((item) => item.id);
    // Writers into knowledge/ settle before the index; code generators before
    // the env scan; the vocabulary catalog before its readers.
    expect(ids.indexOf('knowledge-index')).toBeGreaterThan(ids.indexOf('op-registry'));
    expect(ids.indexOf('vocabulary-types')).toBeGreaterThan(ids.indexOf('pseudo-locale'));
    expect(ids.at(-1)).toBe('changelog-fragments');
  });

  it('flags unknown, duplicate and out-of-order dependencies', () => {
    const base = { script: 's', tracked: [], run: async () => undefined };
    expect(
      validateStepOrder([
        { ...base, id: 'b', after: ['a'] },
        { ...base, id: 'a', after: ['ghost'] },
        { ...base, id: 'a' },
      ])
    ).toEqual(['b must run after a', 'a runs after unknown step ghost', 'duplicate step id a']);
  });

  it('covers every generator --check gate in ci-gates.json', () => {
    const catalog = JSON.parse(readRepoText('knowledge/product/governance/ci-gates.json')) as {
      gates: Array<{ id: string; args?: string[] }>;
    };
    const covered = new Set(GENERATED_ARTIFACT_STEPS.map((item) => item.script));
    const generatorGates = catalog.gates
      .filter((gate) => gate.args?.includes('--check'))
      .flatMap((gate) =>
        (gate.args ?? [])
          .filter((arg) => /^scripts\/(generate|analyze|assemble)_[a-z_]+\.ts$/u.test(arg))
          .map((script) => ({ gate: gate.id, script }))
      );
    expect(generatorGates.length).toBeGreaterThan(0);
    expect(generatorGates.filter(({ script }) => !covered.has(script))).toEqual([]);
  });

  it('names generator scripts that exist', () => {
    for (const item of GENERATED_ARTIFACT_STEPS) {
      expect(() => readRepoText(item.script), item.script).not.toThrow();
    }
  });

  it('matches the merge-driver paths in .gitattributes exactly', () => {
    const driverPaths = readRepoText('.gitattributes')
      .split('\n')
      .filter((line) => !line.startsWith('#') && line.includes('merge=kyberion-regenerate'))
      .map((line) => line.split(/\s+/)[0]);
    const declared = GENERATED_ARTIFACT_STEPS.filter((item) => item.mergeDriver).flatMap(
      (item) => item.tracked
    );
    expect(declared.sort()).toEqual(driverPaths.sort());
  });

  it('keeps the pre-push hook on the same command and skip flag', () => {
    const hook = readRepoText('.husky/pre-push');
    expect(hook).toContain(`${RESOLVE_GENERATED_COMMAND} --check --fast`);
    expect(hook).toContain(PRE_PUSH_SKIP_ENV);
    expect(readRepoText('.husky/post-merge')).toContain(RESOLVE_GENERATED_COMMAND);
  });
});

describe('resolve_generated paths', () => {
  it('normalizes generator paths to repo-relative posix form', () => {
    expect(toRepoRelative('/repo/docs/a.md', ROOT)).toBe('docs/a.md');
    expect(toRepoRelative('.claude/settings.json', ROOT)).toBe('.claude/settings.json');
  });

  it('matches exact tracked paths and directory prefixes', () => {
    const tracked = ['.claude/agents/', 'docs/a.md'];
    expect(isTrackedOutput('.claude/agents/reviewer.md', tracked)).toBe(true);
    expect(isTrackedOutput('docs/a.md', tracked)).toBe(true);
    expect(isTrackedOutput('docs/a.md.bak', tracked)).toBe(false);
    expect(isTrackedOutput('.claude/settings.json', tracked)).toBe(false);
  });

  it('reads generator results, keeping only tracked outputs', () => {
    const result = {
      changed: ['/repo/.gemini/settings.json', '/repo/.claude/settings.json'],
      files: [{ path: '/repo/.claude/settings.json', content: '' }, { path: 7 }],
    };
    const tracked = ['.claude/settings.json'];
    expect(trackedGeneratorPaths(result, 'changed', tracked, ROOT)).toEqual([
      '.claude/settings.json',
    ]);
    expect(trackedGeneratorPaths(result, 'files', tracked, ROOT)).toEqual([
      '.claude/settings.json',
    ]);
    expect(trackedGeneratorPaths(undefined, 'changed', tracked, ROOT)).toBeUndefined();
    expect(trackedGeneratorPaths({ changed: 'x' }, 'changed', tracked, ROOT)).toBeUndefined();
  });

  it('picks only generated paths out of the unmerged list and keeps the hint one line', () => {
    expect(
      unmergedGeneratedPaths(
        'libs/core/foo.ts\nknowledge/_index.md\nknowledge/product/governance/env-registry.json\n.claude/agents/reviewer.md\n'
      )
    ).toEqual([
      'knowledge/_index.md',
      'knowledge/product/governance/env-registry.json',
      '.claude/agents/reviewer.md',
    ]);
    expect(unmergedGeneratedPaths('')).toEqual([]);
    expect(DRIVER_HINT).not.toContain('\n');
    expect(DRIVER_HINT).toContain('pnpm kyberion resolve install-driver');
  });
});

describe('resolveGeneratedArtifacts', () => {
  it('writes and stages every step, keeping validation-only steps in check mode', async () => {
    const calls: string[][] = [];
    const steps = [
      { ...step('a', calls), passes: 2 },
      { ...step('b', calls), tracked: [], checkOnly: true },
      step('c', calls, {
        tracked: ['dir/'],
        result: { changed: [], files: [{ path: '/repo/dir/x.md' }, { path: '/repo/ignored' }] },
      }),
    ];

    await expect(
      resolveGeneratedArtifacts({ check: false, stage: true, rootDir: ROOT }, steps)
    ).resolves.toEqual({ failed: [], drifted: [], staged: ['a.out', 'dir/x.md'], skipped: [] });
    expect(calls).toEqual([
      ['a', '--quiet'],
      ['a', '--quiet'],
      ['b', '--check', '--quiet'],
      ['c', '--quiet'],
    ]);
  });

  it('does not stage with --no-stage', async () => {
    const result = await resolveGeneratedArtifacts({ check: false, stage: false, rootDir: ROOT }, [
      step('a', []),
    ]);
    expect(result).toEqual({ failed: [], drifted: [], staged: [], skipped: [] });
  });

  it('reports every drifted tracked file without staging in check mode', async () => {
    const calls: string[][] = [];
    const result = await resolveGeneratedArtifacts({ check: true, stage: true, rootDir: ROOT }, [
      step('fresh', calls),
      step('stale', calls, {
        exitCode: 1,
        result: { changed: ['/repo/stale.out'], files: [] },
      }),
      step('broken', calls, { exitCode: 1 }),
      step('provider', calls, {
        exitCode: 1,
        tracked: ['.claude/settings.json'],
        result: { changed: ['/repo/.gemini/settings.json'], files: [] },
      }),
    ]);

    expect(result).toEqual({
      failed: ['stale', 'broken'],
      drifted: ['stale.out'],
      staged: [],
      skipped: [],
    });
    expect(calls.every((call) => call.includes('--check'))).toBe(true);
  });

  it('skips slow steps only in fast mode', async () => {
    const calls: string[][] = [];
    const steps = [step('quick', calls), { ...step('slow', calls), slow: true }];
    const fast = await resolveGeneratedArtifacts(
      { check: true, stage: false, fast: true, rootDir: ROOT },
      steps
    );
    expect(fast.skipped).toEqual(['slow']);
    expect(calls.map((call) => call[0])).toEqual(['quick']);
    const full = await resolveGeneratedArtifacts(
      { check: true, stage: false, rootDir: ROOT },
      steps
    );
    expect(full.skipped).toEqual([]);
    // A slow step must stay covered by a CI gate (ci-gates.json cross-check
    // above). None is registered: the role-assumption reachability report is
    // no longer committed — its gate checks policy invariants in memory.
    expect(GENERATED_ARTIFACT_STEPS.filter((item) => item.slow).map((item) => item.id)).toEqual([]);
  });

  it('prints the exact fix command on drift', () => {
    const message = formatResolveFailure(true, ['op-registry'], ['a.json', 'b.json']);
    expect(message).toContain('op-registry');
    expect(message).toContain('\n  - a.json\n  - b.json');
    expect(message).toContain(`run \`${RESOLVE_GENERATED_COMMAND}\``);
    expect(formatResolveFailure(false, ['x'], [])).toContain('generation failed: x');
  });
});
