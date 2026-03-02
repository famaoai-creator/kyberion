import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSkillStructure } from './lib';
import * as fs from 'node:fs';
import { safeWriteFile, safeMkdir } from '@agent/core';

vi.mock('node:fs');
vi.mock('@agent/core', () => ({
  safeWriteFile: vi.fn(),
  safeMkdir: vi.fn(),
}));

describe('autonomous-skill-designer lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create directory structure', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const path = createSkillStructure('new-skill', 'desc', '/root');
    expect(path).toContain('new-skill');
    expect(safeMkdir).toHaveBeenCalled();
    expect(safeWriteFile).toHaveBeenCalled();
  });
});
