import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tailFile } from './lib';
import * as fs from 'node:fs';

vi.mock('node:fs');

describe('log-analyst lib', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return tail content', () => {
    vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);
    vi.mocked(fs.openSync).mockReturnValue(1);
    vi.mocked(fs.readSync).mockReturnValue(100);
    // Buffer.toString will be called on the mock buffer

    const result = tailFile('test.log', 10);
    expect(result.logFile).toBe('test.log');
    expect(result.totalSize).toBe(100);
  });
});
