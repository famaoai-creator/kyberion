import { describe, expect, it } from 'vitest';
import { mergeNamedEntries } from './git_merge_regenerate.mjs';
import { installGitMergeDriver } from './install_git_merge_driver.mjs';

const entry = (name: string, description = '') => ({ name, description, documented: true });
const doc = (...entries: ReturnType<typeof entry>[]) => ({
  $schema: '../schemas/env-registry.schema.json',
  version: '1.0.0',
  entries,
});

describe('git_merge_regenerate (kyberion-regenerate merge driver)', () => {
  it('unions entries both sides added, in generator order', () => {
    const base = doc(entry('KYBERION_A'), entry('KYBERION_Z'));
    const ours = doc(entry('KYBERION_A'), entry('KYBERION_M_OURS', 'ours'), entry('KYBERION_Z'));
    const theirs = doc(
      entry('KYBERION_A'),
      entry('KYBERION_M_THEIRS', 'theirs'),
      entry('KYBERION_Z')
    );

    expect(mergeNamedEntries(base, ours, theirs)?.entries.map((item) => item.name)).toEqual([
      'KYBERION_A',
      'KYBERION_M_OURS',
      'KYBERION_M_THEIRS',
      'KYBERION_Z',
    ]);
  });

  it('keeps a one-sided curated edit and a one-sided deletion', () => {
    const base = doc(entry('KYBERION_A', 'old'), entry('KYBERION_B'));
    const ours = doc(entry('KYBERION_A', 'curated'), entry('KYBERION_B'));
    const theirs = doc(entry('KYBERION_A', 'old'));

    expect(mergeNamedEntries(base, ours, theirs)).toEqual(doc(entry('KYBERION_A', 'curated')));
  });

  it('refuses to pick a side when the same entry changed differently', () => {
    const base = doc(entry('KYBERION_A', 'old'));
    expect(
      mergeNamedEntries(base, doc(entry('KYBERION_A', 'ours')), doc(entry('KYBERION_A', 'theirs')))
    ).toBeNull();
    expect(
      mergeNamedEntries(
        base,
        { ...doc(entry('KYBERION_A', 'old')), version: '1.1.0' },
        { ...doc(entry('KYBERION_A', 'old')), version: '2.0.0' }
      )
    ).toBeNull();
  });

  it('never touches git config in CI', () => {
    expect(installGitMergeDriver({ CI: 'true' })).toEqual({ status: 'skipped:ci', changed: [] });
    expect(installGitMergeDriver({ CI: 'true' }, { uninstall: true }).status).toBe('skipped:ci');
  });
});
