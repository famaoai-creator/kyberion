import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { refineSelf } from './lib';
import * as pathResolver from '@agent/core/path-resolver';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('@agent/core/path-resolver');

describe('self-evolution lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pathResolver.rootDir).mockReturnValue('/root');
    vi.mocked(pathResolver.shared).mockReturnValue('/root/active/shared');
  });

  it('should create a backup and return result', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await refineSelf('GEMINI.md', 'Add new protocols');

    expect(result.target).toBe('GEMINI.md');
    expect(result.reason).toBe('Add new protocols');
    expect(fs.copyFileSync).toHaveBeenCalled();
    expect(result.branch).toContain('feat/self-refinement');
  });

  it('should throw if target file not found', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(refineSelf('ghost.md', 'none')).rejects.toThrow('Target file ghost.md not found.');
  });
});
