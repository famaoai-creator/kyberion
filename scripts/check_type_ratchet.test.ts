import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { checkTypeRatchet } from './check_type_ratchet.js';

const FIXTURE_DIR = pathResolver.sharedTmp('check-type-ratchet');

function writeFixture(relativePath: string, content: string): string {
  const fullPath = pathResolver.sharedTmp(`check-type-ratchet/${relativePath}`);
  safeMkdir(pathResolver.sharedTmp(`check-type-ratchet/${path.dirname(relativePath)}`), {
    recursive: true,
  });
  safeWriteFile(fullPath, content);
  return fullPath;
}

describe('check_type_ratchet', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_DIR)) {
      safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('creates a baseline when requested and no baseline exists', () => {
    const baselinePath = pathResolver.sharedTmp('check-type-ratchet/baseline.json');
    writeFixture(
      'src/example.ts',
      [
        'const value: any = 1;',
        'const copied = value as any;',
        '// @ts-ignore',
        'export const answer = copied;',
      ].join('\n')
    );

    const report = checkTypeRatchet({
      baselinePath,
      scanRoots: [pathResolver.sharedTmp('check-type-ratchet')],
      writeBaseline: true,
    });

    expect(report.violations).toEqual([]);
    expect(safeExistsSync(baselinePath)).toBe(true);
  });

  it('flags increases relative to the stored baseline', () => {
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify(
        {
          version: 1,
          generated_at: '2026-07-01T00:00:00.000Z',
          counts: {
            src: { any_keywords: 0, as_any: 0, ts_ignore: 0, files: 0 },
            test: { any_keywords: 0, as_any: 0, ts_ignore: 0, files: 0 },
          },
        },
        null,
        2
      )
    );
    writeFixture(
      'src/example.ts',
      [
        'const value: any = 1;',
        'const copied = value as any;',
        '// @ts-ignore',
        'export const answer = copied;',
      ].join('\n')
    );

    const report = checkTypeRatchet({
      baselinePath,
      scanRoots: [pathResolver.sharedTmp('check-type-ratchet')],
    });

    expect(report.violations).toEqual([
      'src.any_keywords increased from 0 to 2',
      'src.as_any increased from 0 to 1',
      'src.ts_ignore increased from 0 to 1',
      'src.files increased from 0 to 1',
    ]);
  });

  it('explicitly refreshes an existing baseline', () => {
    const baselinePath = writeFixture(
      'baseline.json',
      JSON.stringify({
        version: 1,
        generated_at: '2026-07-01T00:00:00.000Z',
        counts: {
          src: { any_keywords: 0, as_any: 0, ts_ignore: 0, files: 0 },
          test: { any_keywords: 0, as_any: 0, ts_ignore: 0, files: 0 },
        },
      })
    );
    writeFixture('src/example.ts', 'export const value: unknown = 1;');

    const report = checkTypeRatchet({
      baselinePath,
      scanRoots: [pathResolver.sharedTmp('check-type-ratchet')],
      writeBaseline: true,
    });

    const refreshed = JSON.parse(String(safeReadFile(baselinePath, { encoding: 'utf8' })));
    expect(report.violations).toEqual([]);
    expect(refreshed.counts.src.files).toBe(1);
  });
});
