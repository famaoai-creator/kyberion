import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  buildGhArgs,
  parseDefaultBranchResponse,
  parsePublishArgs,
  resolvePublishTitle,
} from './publish_pull_request.js';

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
      { head: 'codex/pr-guard', defaultBranch: 'main' }
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

  it('rejects unsafe default-branch responses before publish', () => {
    expect(parseDefaultBranchResponse('{"defaultBranchRef":{"name":"main"}}')).toBe('main');
    expect(() =>
      parseDefaultBranchResponse('{"defaultBranchRef":{"__proto__":{"name":"evil"}}}')
    ).toThrow('dangerous JSON key');
  });

  it('routes gh output through the shared harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/publish_pull_request.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
