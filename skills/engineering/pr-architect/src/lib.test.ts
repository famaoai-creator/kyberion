import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRecentCommits, getDiffStat, categorizeChanges, generateTitle, draftPR } from './lib';
import * as secureIo from '@agent/core/secure-io';
import * as fs from 'fs';

vi.mock('@agent/core/secure-io');
vi.mock('fs');

describe('pr-architect', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('getRecentCommits parses log output', () => {
    vi.mocked(secureIo.safeExec).mockReturnValue(
      'abc1234 feat: new feature\\ndef5678 fix: bug fix'
    );
    const commits = getRecentCommits('.');
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ hash: 'abc1234', message: 'feat: new feature' });
  });

  it('getDiffStat parses stat output', () => {
    vi.mocked(secureIo.safeExec).mockReturnValue(' src/index.ts | 10 \\n package.json | 2 ');
    const stats = getDiffStat('.');
    expect(stats).toHaveLength(2);
    expect(stats[0]).toEqual({ file: 'src/index.ts', changes: 10 });
  });

  it('categorizeChanges sorts files', () => {
    const files = [
      { file: 'src/feat.ts', changes: 1 },
      { file: 'src/feat.test.ts', changes: 1 },
      { file: 'README.md', changes: 1 },
      { file: 'config.json', changes: 1 },
    ];
    const categories = categorizeChanges(files);
    expect(categories.tests).toContain('src/feat.test.ts');
    expect(categories.docs).toContain('README.md');
    expect(categories.config).toContain('config.json');
    expect(categories.other).toContain('src/feat.ts');
  });

  it('generateTitle uses latest commit', () => {
    const commits = [{ hash: '123', message: 'feat(core): add feature' }];
    expect(generateTitle(commits)).toBe('feat(core): add feature');
  });

  it('draftPR generates full draft', () => {
    vi.mocked(secureIo.safeExec).mockImplementation((_cmd, args) => {
      if (args && args.includes('log')) return 'abc feat: stuff';
      if (args && args.includes('diff')) return ' file.ts | 1 ';
      return '';
    });
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const draft = draftPR('.');
    expect(draft.title).toBe('feat: stuff');
    expect(draft.description).toContain('## Summary');
    expect(draft.description).toContain('file.ts');
  });
});
