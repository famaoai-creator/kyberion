import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { describe, it, expect } from 'vitest';
import { scanForDataFlows } from './lib';

describe('data-lineage-guardian lib', () => {
  it('should detect file reads and writes', () => {
    const content = 'safeReadFile("in.txt"); safeWriteFile("out.txt", data);';
    const flows = scanForDataFlows(content, 'test.js');
    expect(flows.some((f) => f.type === 'file_read')).toBe(true);
    expect(flows.some((f) => f.type === 'file_write')).toBe(true);
  });
});
