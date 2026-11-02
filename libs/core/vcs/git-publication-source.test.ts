import { describe, expect, it, vi } from 'vitest';
vi.mock('../tier-guard.js', () => ({
  detectTier: (name: string) =>
    name.includes('/personal/')
      ? 'personal'
      : name.includes('/confidential/')
        ? 'confidential'
        : 'public',
}));
vi.mock('./github.js', () => ({
  prPublicationSourceForRelativePath: (name: string) => {
    if (name.includes('/personal/')) return { tier: 'personal' };
    const tenant = name.match(/\/confidential\/(acme|other)\//u)?.[1];
    return tenant ? { tier: 'confidential', tenantSlug: tenant } : 'protected_or_unknown';
  },
}));
import { readGitPublicationSource } from './git-publication-source.js';
import type { VcsCommandRunner } from './git.js';

function runner(history: string, shallow = 'false'): VcsCommandRunner {
  return (_bin, args) => ({
    status: args[0] === 'config' ? 1 : 0,
    stdout: args[0] === 'config' ? '' : args[0] === 'rev-parse' ? shallow : history,
    stderr: '',
  });
}

describe('push reachable-history provenance', () => {
  it('classifies ordinary source and pins a bounded replacement-free full history query', () => {
    const run = vi.fn(runner('src/index.ts\0\nREADME.md\0'));
    expect(readGitPublicationSource('/fixture', 'a'.repeat(40), run)).toMatchObject({
      publication_source_tier: 'public',
      publication_history_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(run.mock.calls.find((call) => call[1][0] === '--no-replace-objects')).toEqual([
      'git',
      [
        '--no-replace-objects',
        'log',
        '--no-ext-diff',
        '--no-textconv',
        '--format=',
        '--name-only',
        '-z',
        '--full-history',
        '--root',
        '--no-renames',
        'a'.repeat(40),
      ],
      expect.objectContaining({ cwd: '/fixture', timeoutMs: 30_000, maxOutputMB: 4 }),
    ]);
  });
  it('retains a confidential path from an earlier deletion rather than only the current tree', () => {
    expect(
      readGitPublicationSource(
        '/fixture',
        'a'.repeat(40),
        runner('src/index.ts\0\nknowledge/confidential/acme/deleted.md\0')
      )
    ).toMatchObject({
      publication_source_tier: 'confidential',
      publication_source_tenant: 'acme',
    });
  });
  it('classifies personal history without inventing a tenant', () => {
    expect(
      readGitPublicationSource('/fixture', 'a'.repeat(40), runner('knowledge/personal/a.md\0'))
    ).toMatchObject({ publication_source_tier: 'personal' });
  });
  it.each([
    'knowledge/confidential/acme/a.md\0knowledge/confidential/other/b.md\0',
    'knowledge/confidential/heuristics/a.md\0',
    'knowledge/personal/a.md\0knowledge/confidential/acme/a.md\0',
    '../knowledge/personal/a.md\0',
    '',
  ])('withholds delegation for ambiguous or mixed history %j', (history) => {
    expect(readGitPublicationSource('/fixture', 'a'.repeat(40), runner(history))).toMatchObject({
      publication_source_tier: 'protected_or_unknown',
    });
  });
  it.each(['true', '', 'invalid'])('refuses incomplete history in shallow state %j', (shallow) => {
    expect(
      readGitPublicationSource('/fixture', 'a'.repeat(40), runner('src/a.ts\0', shallow))
    ).toEqual({ publication_source_tier: 'protected_or_unknown' });
  });
  it('withholds delegation when history cannot be read within the bound', () => {
    const run: VcsCommandRunner = (_bin, args) => ({
      status: args[0] === 'rev-parse' ? 0 : 1,
      stdout: args[0] === 'config' ? '' : args[0] === 'rev-parse' ? 'false' : 'partial',
      stderr: 'bound reached',
    });
    expect(readGitPublicationSource('/fixture', 'a'.repeat(40), run)).toEqual({
      publication_source_tier: 'protected_or_unknown',
    });
  });
});
