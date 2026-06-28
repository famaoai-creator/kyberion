import { describe, expect, it } from 'vitest';
import { buildGhArgs, parsePublishArgs, resolvePublishTitle } from './publish_pull_request.js';

describe('publish_pull_request', () => {
  it('parses explicit publish flags', () => {
    const options = parsePublishArgs(['--title', 'fix(pr): validate before publish', '--no-fill']);
    expect(options.title).toBe('fix(pr): validate before publish');
    expect(options.fill).toBe(false);
    expect(options.draft).toBe(true);
  });

  it('rejects a non-conventional PR title before publish', () => {
    expect(() => resolvePublishTitle('[codex] update docs')).toThrow(/Conventional Commit header/);
  });

  it('builds a guarded gh pr create command', () => {
    const args = buildGhArgs(
      { title: 'fix(pr): validate before publish', draft: true, fill: true },
      { head: 'codex/pr-guard', defaultBranch: 'main' },
    );

    expect(args).toEqual([
      'pr',
      'create',
      '--draft',
      '--fill',
      '--title',
      'fix(pr): validate before publish',
      '--base',
      'main',
      '--head',
      'codex/pr-guard',
    ]);
  });
});
