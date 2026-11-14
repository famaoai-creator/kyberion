import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanPlatformReadBaseline } from '../scripts/generate/generate_platform_read_baseline.ts';

/**
 * Platform read boundary — the gate that keeps OS-specific conditionals out
 * of feature code.
 *
 * Raw `process.platform` / `os.platform()` reads may exist only inside the
 * platform layer and the files listed in
 * `tests/fixtures/platform-read-baseline.json`.
 *
 * New exceptions: run `pnpm generate:platform-read-baseline` and commit the
 * fixture (do not hand-edit the list). New feature code must inject
 * `platform: Platform = currentPlatform` or consume `getPlatformFacts()`.
 * Test files remain exempt from the scan.
 */
const rootDir = process.cwd();
const baselinePath = path.join(rootDir, 'tests', 'fixtures', 'platform-read-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
  allowed_raw_platform_files: string[];
};

function normalize(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

function diffMessage(expected: string[], actual: string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const added = actual.filter((item) => !expectedSet.has(item));
  const removed = expected.filter((item) => !actualSet.has(item));
  return [
    'Platform-read baseline changed.',
    added.length ? `Added:\n${added.join('\n')}` : 'Added:\n(none)',
    removed.length ? `Removed:\n${removed.join('\n')}` : 'Removed:\n(none)',
    'If intentional, run `pnpm generate:platform-read-baseline` and commit the fixture.',
  ].join('\n\n');
}

describe('Platform read boundary', () => {
  it('keeps raw process.platform / os.platform() reads confined to the declared exception set', () => {
    const actual = scanPlatformReadBaseline().allowed_raw_platform_files;
    const expected = normalize(baseline.allowed_raw_platform_files);
    expect(actual, diffMessage(expected, actual)).toEqual(expected);
  });
});
