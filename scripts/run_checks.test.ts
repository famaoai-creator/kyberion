import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { loadGateManifest, main, selectGates, validateGateManifest } from './run_checks.js';

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

  it('fails closed for unknown and empty scopes', async () => {
    await expect(main(['--scope', 'typo', '--json'])).resolves.toBe(1);
    expect(selectGates(loadGateManifest(), 'release').length).toBeGreaterThan(1);
  });

  it('fails closed for unknown options and missing option values', async () => {
    await expect(main(['--unknown'])).resolves.toBe(1);
    await expect(main(['--', '--scope', 'pr', '--only', 'missing'])).resolves.toBe(1);
    await expect(main(['--scope'])).resolves.toBe(1);
    await expect(main(['--only'])).resolves.toBe(1);
  });
});
