import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import { checkPullRequestTitle, checkTitle } from './check_pr_title.js';

const TMP_DIR = pathResolver.sharedTmp('check-pr-title-tests');

describe('check_pr_title', () => {
  beforeEach(() => {
    safeRmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('accepts a conventional commit title', () => {
    const result = checkTitle('feat(release): add migration runner');
    expect(result.ok).toBe(true);
  });

  it('rejects a non-conventional title', () => {
    const result = checkTitle('Add migration runner');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Conventional Commit header/);
  });

  it('reads the title from a GitHub event file', () => {
    const eventPath = path.join(TMP_DIR, 'event.json');
    safeMkdir(TMP_DIR, { recursive: true });
    safeWriteFile(
      eventPath,
      JSON.stringify({ pull_request: { title: 'fix(release): lint PR titles' } }),
      {
        encoding: 'utf8',
      }
    );

    const result = checkPullRequestTitle({ eventPath });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('event file');
  });

  it('fails closed when the event path is a directory or contains a dangerous key', () => {
    safeMkdir(path.join(TMP_DIR, 'directory-event'), { recursive: true });
    expect(checkPullRequestTitle({ eventPath: path.join(TMP_DIR, 'directory-event') }).source).toBe(
      'HEAD commit subject'
    );

    const dangerousPath = path.join(TMP_DIR, 'dangerous-event.json');
    safeWriteFile(dangerousPath, '{"__proto__":{"polluted":true}}', { encoding: 'utf8' });
    expect(checkPullRequestTitle({ eventPath: dangerousPath }).source).toBe('HEAD commit subject');
  });
});
