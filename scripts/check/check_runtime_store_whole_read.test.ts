import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  checkRuntimeStoreWholeRead,
  findWholeStoreReads,
} from './check_runtime_store_whole_read.js';

const FIXTURE_ROOT = pathResolver.sharedTmp('check-runtime-store-whole-read');
const BASELINE = path.join(FIXTURE_ROOT, 'baseline.json');

function writeFixture(relativePath: string, content: string): void {
  safeMkdir(path.dirname(path.join(FIXTURE_ROOT, relativePath)), { recursive: true });
  safeWriteFile(path.join(FIXTURE_ROOT, relativePath), content);
}

function check(writeBaseline = false) {
  return checkRuntimeStoreWholeRead({
    baselinePath: BASELINE,
    rootDir: FIXTURE_ROOT,
    scanRoots: ['libs'],
    writeBaseline,
  });
}

const lines = (...source: string[]) => source.join('\n');

describe('check_runtime_store_whole_read', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_ROOT)) safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('counts whole-file JSONL readers and same-expression read+split in .jsonl files', () => {
    const sites = findWholeStoreReads(
      'a.ts',
      lines(
        "const P = 'active/shared/runtime/x.jsonl';",
        'const rows = readJsonLines<Row>(P);',
        "const cached = json.readJsonLinesCached(P, { onMalformed: 'skip' });",
        "const parts = String(safeReadFile(P)).split('\\n');",
        'const more = readTextFile(P).split(/\\r?\\n/);'
      )
    );
    expect(sites.map((site) => site.line)).toEqual([2, 3, 4, 5]);
  });

  it('resolves renamed imports of the tracked readers', () => {
    const sites = findWholeStoreReads(
      'd.ts',
      lines(
        "import { readJsonLines as rjl, streamJsonLines as sjl } from '@agent/core';",
        "import { safeReadFile as srf } from '@agent/core/secure-io';",
        "const P = 'active/shared/runtime/x.jsonl';",
        'const rows = rjl<Row>(P);',
        'for (const r of sjl(P)) use(r);',
        "const parts = String(srf(P)).split('\\n');"
      )
    );
    expect(sites.map((site) => site.line)).toEqual([4, 6]);
  });

  it('ignores strings, comments, purpose readers, split in non-jsonl files and split-later', () => {
    expect(
      findWholeStoreReads(
        'b.ts',
        lines(
          "const P = 'x.jsonl';",
          '// readJsonLines(P) is banned',
          "const s = 'readJsonLines(P)';",
          'for (const r of streamJsonLines(P)) use(r);',
          'const recent = readJsonLinesSince(P, { cutoff, timeOf });',
          'const raw = readTextFile(P);',
          "const later = raw.split('\\n');",
          "const words = readTextFile(P).split(' ');"
        )
      )
    ).toEqual([]);
    expect(
      findWholeStoreReads('c.ts', "const md = readTextFile('README.md').split('\\n');")
    ).toEqual([]);
  });

  it('passes at the baseline and fails with file:line when a file gains a whole read', () => {
    writeFixture('libs/x.ts', 'readJsonLines(p);\n');
    expect(check(true).total).toBe(1);
    expect(check().violations).toEqual([]);

    writeFixture('libs/x.ts', 'readJsonLines(p);\nreadJsonLines(q);\n');
    const report = check();
    expect(report.violations[0]).toBe('libs/x.ts: 2 whole-file JSONL read(s), baseline allows 1');
    expect(report.violations).toContain('  libs/x.ts:2  readJsonLines(q)');
  });

  it('skips tests and fixtures, fails new files, and reports files below the baseline', () => {
    writeFixture('libs/x.ts', 'readJsonLines(p);\n');
    writeFixture('libs/x.test.ts', 'readJsonLines(p);\n');
    writeFixture('libs/fixtures/f.ts', 'readJsonLines(p);\n');
    expect(check(true).files).toEqual({ 'libs/x.ts': 1 });

    writeFixture('libs/x.ts', 'for (const r of streamJsonLines(p)) use(r);\n');
    writeFixture('libs/y.ts', 'readJsonLinesCached(p);\n');
    const report = check();
    expect(report.violations[0]).toBe('libs/y.ts: 1 whole-file JSONL read(s), baseline allows 0');
    expect(report.improved).toEqual(['libs/x.ts']);
  });

  it('reports a missing baseline as a violation', () => {
    writeFixture('libs/x.ts', 'readJsonLines(p);\n');
    expect(check().violations[0]).toMatch(/^baseline missing:/u);
  });
});
