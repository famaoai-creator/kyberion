import { describe, expect, it } from 'vitest';
import { resolveChangelogPolicy } from '@agent/core';
import { classify, parseCommit, renderSection } from './generate_changelog.js';

describe('generate_changelog', () => {
  it('parses conventional commits and preserves breaking markers', () => {
    const commit = parseCommit(
      'abcdef1234567890',
      'abcdef1',
      'feat(release)!: add release notes generator',
      'BREAKING CHANGE: output shape changes'
    );

    expect(commit).toMatchObject({
      hash: 'abcdef1234567890',
      shortHash: 'abcdef1',
      type: 'feat',
      scope: 'release',
      breaking: true,
      subject: 'add release notes generator',
    });
    expect(classify(commit)).toBe('breaking');
  });

  it('renders a changelog section using the changelog policy headings', () => {
    const policy = resolveChangelogPolicy();
    const section = renderSection(
      [
        parseCommit('1111111111111111', '1111111', 'feat: add deploy release notes', ''),
        parseCommit('2222222222222222', '2222222', 'fix(api): correct changelog extraction', ''),
        parseCommit('3333333333333333', '3333333', 'docs: update release operations', ''),
        parseCommit(
          '4444444444444444',
          '4444444',
          'refactor!: split changelog renderer',
          'BREAKING CHANGE: renderer output changes'
        ),
        parseCommit('5555555555555555', '5555555', 'update release notes formatting', ''),
      ],
      'v1.0.0',
      'HEAD'
    );

    expect(section).toContain(`### ${policy.breaking_changes_title}`);
    expect(section).toContain(`### ${policy.type_labels.feat}`);
    expect(section).toContain(`### ${policy.type_labels.fix}`);
    expect(section).toContain(`### ${policy.type_labels.docs}`);
    expect(section).toContain(`### ${policy.uncategorized_title}`);
    expect(section).toContain('add deploy release notes');
    expect(section).toContain('correct changelog extraction');
    expect(section).toContain('update release operations');
    expect(section).toContain('split changelog renderer');
    expect(section).toContain('update release notes formatting');
  });

  it('renders the no-commits template when the range is empty', () => {
    const section = renderSection([], 'v1.0.0', 'HEAD');
    expect(section).toContain('v1.0.0');
    expect(section).toContain('HEAD');
  });
});
