import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createShadowTasks } from './lib';
import * as fs from 'node:fs';
import { safeWriteFile, safeMkdir } from '@agent/core';

vi.mock('node:fs');
vi.mock('@agent/core', () => ({
  safeWriteFile: vi.fn(),
  safeMkdir: vi.fn(),
}));

describe('shadow-dispatcher lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create shadow tasks in inbox', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { idA, idB } = createShadowTasks('test intent', 'A', 'B', '/inbox');
    expect(idA).toContain('SHADOW-A');
    expect(idB).toContain('SHADOW-B');
    expect(safeWriteFile).toHaveBeenCalledTimes(2);
  });
});
