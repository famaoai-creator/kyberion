import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  checkFirstWinDocs,
  FIRST_WIN_COMMANDS,
  readFirstWinDocsTextFile,
} from './check_first_win_docs.js';

describe('first-win documentation contract', () => {
  it('rejects a directory replacement before document parsing', () => {
    expect(() => readFirstWinDocsTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for entry documents', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_first_win_docs.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('keeps the three entry documents on the same five-command path', () => {
    expect(FIRST_WIN_COMMANDS).toHaveLength(5);
    expect(checkFirstWinDocs()).toEqual([]);
  });
});
