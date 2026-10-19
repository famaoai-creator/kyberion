import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  collectChangedFiles,
  DEFAULT_GATE_TIMEOUT_MS,
  loadGateManifest,
  main,
  selectGates,
  validateGateManifest,
} from './run_checks.js';

const gate = (id: string, scope: 'pr' | 'full' | 'release') => ({
  id,
  scope,
  script: `check:${id}`,
  owner: 'test',
  rationale: 'test gate',
});

describe('manifest-driven check runner', () => {
  it('uses the governed package manifest loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_checks.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('readJson<{ scripts?: Record<string, string> }>(');
    expect(source).not.toContain('console.error');
    expect(source).toContain('print(`[check] ERROR ${message}`)');
  });

  it('gives the role-assumption analyzer a justified budget instead of a larger global default', () => {
    // It builds one TypeScript program over scripts/ and libs/; under the
    // 6-gate concurrent pr run it exceeded the 120s default (runbook §1).
    expect(DEFAULT_GATE_TIMEOUT_MS).toBe(120_000);
    const reachability = loadGateManifest().gates.find(
      (entry) => entry.id === 'role-assumption-reachability'
    );
    expect(reachability?.timeout_ms).toBeGreaterThan(DEFAULT_GATE_TIMEOUT_MS);
    expect(reachability?.timeout_ms).toBeLessThanOrEqual(300_000);
    expect(reachability?.rationale).toMatch(/Budget:/);
  });

  it('keeps --only inside the requested scope', () => {
    const manifest = {
      version: 1,
      gates: [gate('pr-gate', 'pr'), gate('release-gate', 'release')],
    };
    expect(selectGates(manifest, 'pr')).toHaveLength(1);
    expect(() => selectGates(manifest, 'release', 'pr-gate')).toThrow(
      'not registered for scope release'
    );
  });

  it('rejects duplicate and recursive gate definitions', () => {
    expect(() =>
      validateGateManifest({ version: 1, gates: [gate('same', 'pr'), gate('same', 'full')] })
    ).toThrow('duplicate');
    expect(() =>
      validateGateManifest({
        version: 1,
        gates: [{ ...gate('recursive', 'pr'), script: 'validate' }],
      })
    ).toThrow('itself');
  });

  it('rejects script gates that are absent from the package script registry', () => {
    expect(() =>
      validateGateManifest(
        { version: 1, gates: [{ ...gate('missing', 'full'), script: 'check:missing' }] },
        new Set(['check:present'])
      )
    ).toThrow('unknown package script');
  });

  it('fails closed for malformed runtime manifest entries', () => {
    expect(() => validateGateManifest({ version: 2, gates: [gate('versioned', 'pr')] })).toThrow(
      'version must be 1'
    );
    expect(() =>
      validateGateManifest({
        version: 1,
        gates: [
          {
            ...gate('malformed', 'pr'),
            args: ['--valid', 42 as unknown as string],
          },
        ],
      })
    ).toThrow('args must be an array of strings');
    expect(() =>
      validateGateManifest({
        version: 1,
        gates: [{ ...gate('malformed-owner', 'pr'), owner: '   ' }],
      })
    ).toThrow('non-empty owner');
  });

  it('fails closed for unknown and empty scopes', async () => {
    await expect(main(['--scope', 'typo', '--json'])).resolves.toBe(1);
    expect(selectGates(loadGateManifest(), 'release').length).toBeGreaterThan(1);
  });

  it('fails closed for unknown options and missing option values', async () => {
    const output: unknown[] = [];
    await expect(main(['--unknown'], (value) => output.push(value))).resolves.toBe(1);
    expect(output).toEqual(['[check] ERROR unknown check option: --unknown']);
    await expect(main(['--', '--scope', 'pr', '--only', 'missing'])).resolves.toBe(1);
    await expect(main(['--scope'])).resolves.toBe(1);
    await expect(main(['--only'])).resolves.toBe(1);
  });

  it('looks a named gate up in the full set when no scope is given', async () => {
    const output: Array<{ scope?: string; error?: string }> = [];
    await expect(
      main(['--only', 'missing-gate', '--json'], (value) => output.push(value as never))
    ).resolves.toBe(1);
    expect(output[0]).toMatchObject({
      scope: 'full',
      error: 'gate(s) missing-gate are not registered for scope full',
    });
  });

  it('rejects --changed combined with an explicit scope and --base without --changed', async () => {
    const output: unknown[] = [];
    const print = (value: unknown) => output.push(value);
    await expect(main(['--changed', '--scope', 'full'], print)).resolves.toBe(1);
    await expect(main(['--base', 'origin/main'], print)).resolves.toBe(1);
    await expect(main(['--changed', '--base'], print)).resolves.toBe(1);
    expect(output).toEqual([
      '[check] ERROR --changed selects gates itself; do not combine it with --scope or --only',
      '[check] ERROR --base requires --changed',
      '[check] ERROR --base requires a value',
    ]);
  });

  it('gives every full-only gate except runtime/UI-bound ones a path trigger', () => {
    const untriggered = loadGateManifest()
      .gates.filter((entry) => entry.scope === 'full' && !entry.paths?.length)
      .map((entry) => entry.id);
    expect(untriggered).toEqual(['chronos-dom-contrast', 'audit-continuity']);
  });
});

describe('collectChangedFiles', () => {
  const fakeGit =
    (responses: Record<string, { status: number; stdout?: string; stderr?: string }>) =>
    (args: string[]) => {
      const response = responses[args.join(' ')] ?? { status: 128, stderr: 'unknown ref' };
      return { stdout: '', stderr: '', ...response };
    };

  it('falls back from origin/main to main and unions diff with untracked files', () => {
    const git = fakeGit({
      'merge-base HEAD main': { status: 0, stdout: 'abc123\n' },
      'diff --name-only --no-renames abc123 --': {
        status: 0,
        stdout: 'libs/actuators/a.ts\nscripts/b.ts\n',
      },
      'ls-files --others --exclude-standard': { status: 0, stdout: 'scripts/b.ts\nnew.md\n' },
    });
    expect(collectChangedFiles(undefined, git)).toEqual({
      base: 'main',
      mergeBase: 'abc123',
      files: ['libs/actuators/a.ts', 'new.md', 'scripts/b.ts'],
    });
  });

  it('uses only an explicit base and fails closed when it cannot be resolved', () => {
    expect(() => collectChangedFiles('develop', fakeGit({}))).toThrow(
      'could not resolve a merge-base with develop'
    );
    expect(() => collectChangedFiles('--output=x', fakeGit({}))).toThrow('git ref name');
  });
});
