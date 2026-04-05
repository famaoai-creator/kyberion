import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeLstat, safeReadFile, safeReaddir } from './secure-io.js';

const ALLOWLIST = [
  /\/libs\/core\/secure-io\.ts$/,
  /\/libs\/core\/fs-primitives\.ts$/,
  /\/libs\/core\/src\/lock-utils\.ts$/,
  /\/libs\/core\/src\/native-(pdf|pptx|xlsx|docx)-engine\/.*\.ts$/,
];

function collectProductionTsFiles(dir: string): string[] {
  const entries = safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = `${dir}/${entry}`;
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      files.push(...collectProductionTsFiles(fullPath));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

describe('security boundary contract', () => {
  it('keeps raw fs imports confined to reviewed low-level boundaries', () => {
    const repoRoot = pathResolver.rootDir();
    const candidates = [
      ...collectProductionTsFiles(`${repoRoot}/libs`),
      ...collectProductionTsFiles(`${repoRoot}/scripts`),
    ];

    const offenders = candidates.filter((filePath) => {
      const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const usesRawFs =
        source.includes("from 'node:fs'") ||
        source.includes('from "node:fs"') ||
        source.includes("from 'fs'") ||
        source.includes('from "fs"');
      if (!usesRawFs) return false;
      return !ALLOWLIST.some((pattern) => pattern.test(filePath));
    });

    expect(offenders).toEqual([]);
  });
});
