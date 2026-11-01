import { describe, expect, it } from 'vitest';
import { validateManagedBinaryArchiveEntries } from '../scripts/tool_runtime_setup.js';

describe('validateManagedBinaryArchiveEntries', () => {
  it('accepts flat executable entries like the agent-desktop tarball', () => {
    expect(
      validateManagedBinaryArchiveEntries(
        'agent_desktop',
        'agent-desktop\nagent-desktop-macos-helper\n'
      )
    ).toEqual(['agent-desktop', 'agent-desktop-macos-helper']);
  });

  it('normalizes ./-prefixed entries', () => {
    expect(validateManagedBinaryArchiveEntries('t', './bin/tool\n./README.md')).toEqual([
      'bin/tool',
      'README.md',
    ]);
  });

  it('rejects an empty archive', () => {
    expect(() => validateManagedBinaryArchiveEntries('t', '\n \n')).toThrow('empty');
  });

  it.each(['/abs/path', '../escape', 'a/../../escape', 'C:/win/drive', 'c:\\win\\drive'])(
    'rejects unsafe entry %s',
    (entry) => {
      expect(() => validateManagedBinaryArchiveEntries('t', `ok\n${entry}\n`)).toThrow(
        'unsafe entry path'
      );
    }
  );
});
