import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { checkTestSleepRatchet, findTestSleeps } from './check_test_sleep_ratchet.js';

const FIXTURE_ROOT = pathResolver.sharedTmp('check-test-sleep-ratchet');
const BASELINE = path.join(FIXTURE_ROOT, 'baseline.json');

function writeFixture(relativePath: string, content: string): void {
  safeMkdir(path.dirname(path.join(FIXTURE_ROOT, relativePath)), { recursive: true });
  safeWriteFile(path.join(FIXTURE_ROOT, relativePath), content);
}

function check(writeBaseline = false) {
  return checkTestSleepRatchet({
    baselinePath: BASELINE,
    rootDir: FIXTURE_ROOT,
    scanRoots: ['libs'],
    writeBaseline,
  });
}

const lines = (...source: string[]) => source.join('\n');

describe('check_test_sleep_ratchet', () => {
  afterEach(() => {
    if (safeExistsSync(FIXTURE_ROOT)) safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('counts real-time sleeps and their lines', () => {
    const sites = findTestSleeps(
      'a.test.ts',
      lines(
        'await new Promise((resolve) => setTimeout(resolve, 10));',
        'await new Promise((r) => setTimeout(() => r(), 1_000));',
        'await sleep(25);',
        'await delayMs(5);',
        "import { setTimeout as wait } from 'node:timers/promises';",
        'await setTimeout(50);'
      )
    );
    expect(sites.map((site) => site.line)).toEqual([1, 2, 3, 4, 6]);
  });

  it('ignores event-loop yields, timeout guards, strings and non-literal helper calls', () => {
    const sites = findTestSleeps(
      'b.test.ts',
      lines(
        'await new Promise((resolve) => setTimeout(resolve, 0));',
        'await new Promise((resolve) => setImmediate(resolve));',
        "setTimeout(() => reject(new Error('timed out')), 2_000);",
        'setTimeout(() => controller.abort(), 50);',
        "const script = 'await new Promise(r => setTimeout(r, 100))';",
        'await sleep(0);',
        'await vi.advanceTimersByTimeAsync(500);'
      )
    );
    expect(sites).toEqual([]);
  });

  it('passes at the baseline and fails with file:line when a file gains a sleep', () => {
    writeFixture('libs/x.test.ts', 'await new Promise((r) => setTimeout(r, 10));\n');
    expect(check(true).total).toBe(1);
    expect(check().violations).toEqual([]);

    writeFixture(
      'libs/x.test.ts',
      'await new Promise((r) => setTimeout(r, 10));\nawait new Promise((r) => setTimeout(r, 20));\n'
    );
    const report = check();
    expect(report.violations[0]).toBe('libs/x.test.ts: 2 real-time sleep(s), baseline allows 1');
    expect(report.violations).toContain('  libs/x.test.ts:2  setTimeout(r, 20)');
  });

  it('fails a new file and reports files that dropped below the baseline', () => {
    writeFixture('libs/x.test.ts', 'await sleep(10);\n');
    check(true);
    writeFixture('libs/x.test.ts', 'vi.setSystemTime(Date.now() + 10);\n');
    writeFixture('libs/y.test.ts', 'await sleep(10);\n');
    const report = check();
    expect(report.violations[0]).toBe('libs/y.test.ts: 1 real-time sleep(s), baseline allows 0');
    expect(report.improved).toEqual(['libs/x.test.ts']);
  });

  it('only scans test files', () => {
    writeFixture('libs/x.ts', 'await new Promise((r) => setTimeout(r, 10));\n');
    expect(check(true).total).toBe(0);
  });
});
