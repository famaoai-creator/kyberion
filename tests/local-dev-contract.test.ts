import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Local dev contract', () => {
  it('tracks the current watch loop and keeps the workspace watch as future work', () => {
    const doc = read('docs/developer/LOCAL_DEV.md');
    const pkg = read('package.json');
    expect(doc).toContain('pnpm dev:watch');
    expect(doc).toContain('single-command workspace watch mode');
    expect(pkg).toContain('"dev:watch"');
  });
});
