import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeReadFile,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { resolveInputPath, resolveOutputPath } from './extract_changelog_section.js';

describe('extract changelog section resource boundaries', () => {
  it('requires an in-repository regular input file', () => {
    expect(() => resolveInputPath('/tmp/changelog.md')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolveOutputPath('../release-notes.md')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects a directory input', () => {
    const directory = pathResolver.sharedTmp('extract-changelog/input-directory');
    safeMkdir(directory, { recursive: true });

    try {
      expect(() => resolveInputPath(pathResolver.toRepoRelative(directory))).toThrow(
        'CHANGELOG must be an existing regular file'
      );
    } finally {
      if (safeExistsSync(directory)) safeRmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a symlink input even when the link is in the repository', () => {
    const target = pathResolver.sharedTmp('extract-changelog/target.md');
    const link = pathResolver.sharedTmp('extract-changelog/link.md');
    safeWriteFile(target, '# Changelog\n');
    safeSymlinkSync(target, link);

    try {
      expect(() => resolveInputPath(pathResolver.toRepoRelative(link))).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
    } finally {
      if (safeExistsSync(link)) safeRmSync(link, { force: true });
      if (safeExistsSync(target)) safeRmSync(target, { force: true });
    }
  });

  it('routes CLI output through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/extract_changelog_section.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).not.toContain('process.stdout.write');
    expect(source).toContain('return main(context.argv, context.print)');
  });
});
