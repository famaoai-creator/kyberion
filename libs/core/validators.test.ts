import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readJsonFile,
  safeJsonParse,
  validateDirPath,
  validateFileFreshness,
  validateFilePath,
} from './validators.js';

describe('validators', () => {
  const tmpRoot = path.join(process.cwd(), 'active/shared/tmp/validators-test');
  const filePath = path.join(tmpRoot, 'data.json');
  const dirPath = path.join(tmpRoot, 'folder');

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ok: true }));

  it('validates file and directory paths', () => {
    expect(validateFilePath(filePath)).toBe(path.resolve(filePath));
    expect(validateDirPath(dirPath)).toBe(path.resolve(dirPath));
  });

  it('rejects missing or mismatched paths', () => {
    expect(() => validateFilePath(undefined)).toThrow('Missing required input file path');
    expect(() => validateFilePath(dirPath)).toThrow('Not a file');
    expect(() => validateDirPath(filePath)).toThrow('Not a directory');
  });

  it('parses JSON strings and files with descriptive failures', () => {
    expect(safeJsonParse('{"ok":true}')).toEqual({ ok: true });
    expect(readJsonFile(filePath)).toEqual({ ok: true });
    expect(() => safeJsonParse('{', 'payload')).toThrow('Invalid payload');
  });

  it('checks file freshness against a threshold', () => {
    expect(() => validateFileFreshness(filePath, 60 * 1000)).not.toThrow();

    const stale = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(filePath, stale / 1000, stale / 1000);
    expect(() => validateFileFreshness(filePath, 60 * 1000)).toThrow('STALE_STATE_ERROR');
  });
});
