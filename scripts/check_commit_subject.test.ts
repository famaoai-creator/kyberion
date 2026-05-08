import { describe, expect, it } from 'vitest';
import { checkCommitSubject } from './check_commit_subject.js';

describe('check_commit_subject', () => {
  it('accepts a conventional commit subject', () => {
    expect(checkCommitSubject('fix(ci): enforce merge subject').ok).toBe(true);
  });

  it('rejects a non-conventional commit subject', () => {
    const result = checkCommitSubject('Update ci checks');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Conventional Commit header/);
  });
});
