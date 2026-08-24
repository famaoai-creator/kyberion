import { describe, expect, it } from 'vitest';
import { checkFirstWinDocs, FIRST_WIN_COMMANDS } from './check_first_win_docs.js';

describe('first-win documentation contract', () => {
  it('keeps the three entry documents on the same five-command path', () => {
    expect(FIRST_WIN_COMMANDS).toHaveLength(5);
    expect(checkFirstWinDocs()).toEqual([]);
  });
});
