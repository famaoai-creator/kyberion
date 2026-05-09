import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver, safeMkdir, safeWriteFile, safeRmSync } from '@agent/core';
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
    safeWriteFile(eventPath, JSON.stringify({ pull_request: { title: 'fix(release): lint PR titles' } }), {
      encoding: 'utf8',
    });

    const result = checkPullRequestTitle({ eventPath });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('event file');
  });
});
