import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { fileUtils } from './core.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('fileUtils.readJson resource boundary', () => {
  it('reads and parses a regular JSON file', () => {
    const filePath = pathResolver.sharedTmp(`core-file-utils-${process.pid}.json`);
    safeWriteFile(filePath, JSON.stringify({ active_role: 'operator' }));
    try {
      expect(fileUtils.readJson(filePath)).toEqual({ active_role: 'operator' });
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('fails closed for a directory before raw JSON reading', () => {
    const directoryPath = pathResolver.sharedTmp(`core-file-utils-directory-${process.pid}.json`);
    safeMkdir(directoryPath, { recursive: true });
    try {
      expect(fileUtils.readJson(directoryPath)).toBeNull();
    } finally {
      safeRmSync(directoryPath, { recursive: true, force: true });
    }
  });
});
