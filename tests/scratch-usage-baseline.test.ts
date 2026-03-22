import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';

const rootDir = process.cwd();

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

describe('Governed temp hierarchy', () => {
  it('keeps scratch/ out of runtime source and policy files', () => {
    const actual = getAllFiles(rootDir)
      .map((filePath) => normalize(path.relative(rootDir, filePath)))
      .filter((relPath) => !relPath.startsWith('dist/'))
      .filter((relPath) => !relPath.includes('/.next/'))
      .filter((relPath) => /\.(ts|tsx|js|jsx|mjs|cjs|md|json)$/.test(relPath))
      .filter((relPath) => safeExistsSync(path.join(rootDir, relPath)))
      .filter((relPath) => {
        const content = safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
        return content.includes('scratch/');
      })
      .filter((relPath) => !relPath.startsWith('knowledge/public/'))
      .filter((relPath) => !relPath.startsWith('knowledge/confidential/'))
      .filter((relPath) => !relPath.startsWith('knowledge/personal/'))
      .filter((relPath) => !relPath.startsWith('docs/'))
      .filter((relPath) => !['CLAUDE.md', 'CODEX.md', 'GEMINI.md'].includes(relPath))
      .filter((relPath) => relPath !== 'eslint.config.js')
      .filter((relPath) => relPath !== 'tests/scratch-usage-baseline.test.ts')
      .sort((a, b) => a.localeCompare(b));

    expect(actual).toEqual([]);
  });
});
