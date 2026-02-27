import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStagedDiff } from './lib';
import * as secureIo from '@agent/core/secure-io';

vi.mock('@agent/core/secure-io');

describe('getStagedDiff', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return diff when changes exist', () => {
    // Avoid newline literal issues in write_file
    const fakeDiff = ['diff --git a/file.txt b/file.txt', 'index 123..456', '+++ b/file.txt'].join(
      '\n'
    );
    vi.mocked(secureIo.safeExec).mockReturnValue(fakeDiff);

    const result = getStagedDiff();

    expect(result.status).toBe('has_changes');
    expect(result.diff).toBe(fakeDiff);
    expect(result.instructions).toBeDefined();
  });

  it('should return no_changes when diff is empty', () => {
    // String with whitespace
    vi.mocked(secureIo.safeExec).mockReturnValue('   ');

    const result = getStagedDiff();

    expect(result.status).toBe('no_changes');
    expect(result.message).toContain('No staged changes');
  });

  it('should return error when command fails', () => {
    vi.mocked(secureIo.safeExec).mockImplementation(() => {
      throw new Error('git command failed');
    });

    const result = getStagedDiff();

    expect(result.status).toBe('error');
    expect(result.message).toContain('git command failed');
  });
});
