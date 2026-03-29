import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();
const allowedImporters = new Set([
  'libs/core/core.ts',
  'libs/core/path-resolver.ts',
  'libs/core/tier-guard.ts',
]);

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

describe('Foundation IO boundary', () => {
  it('restricts fs-primitives imports to foundational modules', () => {
    const codeFiles = getAllFiles(rootDir).filter((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(filePath));
    const importers = codeFiles
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => relPath !== 'libs/core/fs-primitives.ts')
      .filter((relPath) => !relPath.startsWith('dist/'))
      .filter((relPath) => !relPath.includes('/dist/'))
      .filter((relPath) => !relPath.startsWith('active/shared/tmp/'))
      .filter((relPath) => !relPath.startsWith('active/shared/runtime/'))
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return /from\s+['"][^'"]*fs-primitives(?:\.js)?['"]/.test(content);
      })
      .sort((a, b) => a.localeCompare(b));

    expect(importers).toEqual([...allowedImporters].sort((a, b) => a.localeCompare(b)));
  });
});
