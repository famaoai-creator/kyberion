import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sharedTmp } from '../path-resolver.js';
import { safeExecResult, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { readGitPublicationSource } from './git-publication-source.js';

describe('real git history publication scope', () => {
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
