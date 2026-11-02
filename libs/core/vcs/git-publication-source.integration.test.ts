import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pathResolver, sharedTmp } from '../path-resolver.js';
import { safeExecResult, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { readGitPublicationSource } from './git-publication-source.js';

describe('real git history publication scope', () => {
  it.each([
    ['knowledge/personal/merge-only.md', { publication_source_tier: 'personal' }],
    [
      'knowledge/confidential/acme/merge-only.md',
      { publication_source_tier: 'confidential', publication_source_tenant: 'acme' },
    ],
    ['knowledge/public/merge-only.md', { publication_source_tier: 'public' }],
  ])('classifies a path introduced only by merge resolution: %s', (mergePath, expected) => {
    const root = sharedTmp(`vitest-git-publication/${randomUUID()}`);
    const git = (...args: string[]) => {
      const result = safeExecResult('git', args, { cwd: root });
      if (result.error || result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const commitFile = (name: string, content: string) => {
      safeMkdir(path.dirname(path.join(root, name)), { recursive: true });
      safeWriteFile(path.join(root, name), content);
      git('add', '--', name);
      git('commit', '-q', '-m', 'fixture change');
      return git('rev-parse', 'HEAD');
    };
    try {
      safeMkdir(root, { recursive: true });
      // Seed only the synthetic tenant lookup in this isolated fixture; never
      // depend on or write to the operator's real tenant registry.
      const profile = path.join(root, 'tenant-profile.json');
      safeWriteFile(profile, JSON.stringify({ tenant_slug: 'acme', status: 'active' }));
      const resolve = pathResolver.rootResolve.bind(pathResolver);
      vi.spyOn(pathResolver, 'rootResolve').mockImplementation((value) =>
        value === 'knowledge/personal/tenants/acme.json' ? profile : resolve(value)
      );
      git('init', '-q');
      git('config', 'user.name', 'Vitest');
      git('config', 'user.email', 'vitest@kyberion.local');
      git('config', 'commit.gpgsign', 'false');
      const base = commitFile('README.md', 'public root');
      git('checkout', '-q', '-b', 'fixture-left');
      const left = commitFile('left.md', 'public left parent');
      git('checkout', '-q', '-b', 'fixture-right', base);
      const right = commitFile('right.md', 'public right parent');
      git('merge', '--no-ff', '--no-commit', 'fixture-left');
      const merged = commitFile(mergePath, 'synthetic merge-only fixture');
      expect(git('rev-list', '--parents', '-n', '1', merged).split(' ')).toEqual([
        merged,
        right,
        left,
      ]);
      for (const parent of [left, right])
        expect(git('ls-tree', '-r', '--name-only', parent).split('\n')).not.toContain(mergePath);
      expect(readGitPublicationSource(root, merged, safeExecResult)).toMatchObject(expected);
      expect(readGitPublicationSource(root, merged, safeExecResult, base)).toMatchObject(expected);

      git('rm', '-q', '--', mergePath);
      git('commit', '-q', '-m', 'delete merge-only fixture');
      const deleted = git('rev-parse', 'HEAD');
      expect(git('ls-tree', '-r', '--name-only', deleted).split('\n')).not.toContain(mergePath);
      expect(readGitPublicationSource(root, deleted, safeExecResult)).toMatchObject(expected);

      const updated = commitFile('README.md', 'public update after deletion');
      expect(readGitPublicationSource(root, updated, safeExecResult, deleted)).toMatchObject({
        publication_source_tier: 'public',
      });
    } finally {
      vi.restoreAllMocks();
      safeRmSync(root, { recursive: true, force: true });
    }
  });

  it('retains deleted personal artifacts using the real runner and canonical classifier', () => {
    const root = sharedTmp(`vitest-git-publication/${randomUUID()}`);
    const git = (...args: string[]) => {
      const result = safeExecResult('git', args, { cwd: root });
      if (result.error || result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      safeMkdir(root, { recursive: true });
      git('init', '-q');
      git('config', 'user.name', 'Vitest');
      git('config', 'user.email', 'vitest@kyberion.local');
      git('config', 'commit.gpgsign', 'false');
      safeWriteFile(path.join(root, 'README.md'), 'public fixture');
      git('add', '--', 'README.md');
      git('commit', '-q', '-m', 'public source');
      const publicHead = git('rev-parse', 'HEAD');
      expect(readGitPublicationSource(root, publicHead, safeExecResult)).toMatchObject({
        publication_source_tier: 'public',
      });
      const personal = path.join(root, 'knowledge/personal/deleted.md');
      safeMkdir(path.dirname(personal), { recursive: true });
      safeWriteFile(personal, 'private fixture only');
      git('add', '--', 'knowledge/personal/deleted.md');
      git('commit', '-q', '-m', 'personal artifact');
      const personalHead = git('rev-parse', 'HEAD');
      git('rm', '-q', '--', 'knowledge/personal/deleted.md');
      git('commit', '-q', '-m', 'delete personal artifact');
      // The current tree is public again, but a first push carries the earlier blob.
      expect(git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('README.md');
      expect(
        readGitPublicationSource(root, git('rev-parse', 'HEAD'), safeExecResult)
      ).toMatchObject({
        publication_source_tier: 'personal',
      });
      expect(readGitPublicationSource(root, publicHead, safeExecResult, publicHead)).toMatchObject({
        publication_source_tier: 'public',
      });
      expect(
        readGitPublicationSource(root, git('rev-parse', 'HEAD'), safeExecResult, personalHead)
      ).toMatchObject({ publication_source_tier: 'personal' });
      const alreadyDelivered = git('rev-parse', 'HEAD');
      safeWriteFile(path.join(root, 'README.md'), 'public update after deletion');
      git('add', '--', 'README.md');
      git('commit', '-q', '-m', 'ordinary update');
      expect(
        readGitPublicationSource(root, git('rev-parse', 'HEAD'), safeExecResult, alreadyDelivered)
      ).toMatchObject({ publication_source_tier: 'public' });
    } finally {
      safeRmSync(root, { recursive: true, force: true });
    }
  });
});
