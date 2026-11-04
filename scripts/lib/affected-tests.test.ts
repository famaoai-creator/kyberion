import { describe, expect, it } from 'vitest';
import {
  ciTestPaths,
  dataFilesOf,
  isCiTest,
  isVitestRerunTrigger,
  findReaderTests,
  isCodeFile,
  MAX_READERS_PER_FILE,
  planAffectedTests,
  readerNeedles,
} from './affected-tests.js';

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

describe('affected tests planning', () => {
  it('splits code from data / doc files and ignores generated or changelog paths', () => {
    expect(isCodeFile('libs/core/a.ts')).toBe(true);
    expect(isCodeFile('scripts/x.mjs')).toBe(true);
    expect(isCodeFile('AGENTS.md')).toBe(false);
    expect(
      dataFilesOf([
        'libs/core/a.ts',
        'AGENTS.md',
        'knowledge/_index.md',
        'changelog.d/x.md',
        'pnpm-lock.yaml',
        'knowledge/product/governance/seam-provider-selection/ocr-provider.json',
      ])
    ).toEqual([
      'AGENTS.md',
      'knowledge/product/governance/seam-provider-selection/ocr-provider.json',
    ]);
  });

  it('searches for the path, the knowledge-relative path and a distinctive basename', () => {
    expect(readerNeedles('knowledge/product/governance/ci-gates.json')).toEqual([
      'knowledge/product/governance/ci-gates.json',
      'product/governance/ci-gates.json',
      'ci-gates.json',
    ]);
    // Generic basenames are only matched by their full path.
    expect(readerNeedles('libs/actuators/x/manifest.json')).toEqual([
      'libs/actuators/x/manifest.json',
    ]);
  });

  it('uses fixed-string git grep over test files and treats exit 1 as no match', () => {
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      return { status: 1, stdout: '', stderr: '' };
    };
    expect(findReaderTests(['AGENTS.md'], git)).toEqual([]);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['grep', '--untracked', '-l', '-F', '-e', 'AGENTS.md', '--'])
    );
    expect(() => findReaderTests(['x'], () => ({ status: 2, stdout: '', stderr: 'boom' }))).toThrow(
      'git grep for reader tests failed: boom'
    );
  });

  it('drops a match that selects too many tests to mean anything', () => {
    const many = Array.from({ length: MAX_READERS_PER_FILE + 1 }, (_, i) => `t${i}.test.ts`);
    const plan = planAffectedTests(
      { base: 'origin/main', files: ['README.md', 'AGENTS.md'] },
      (args) => (args.includes('README.md') ? ok(many.join('\n')) : ok('tests/agents.test.ts\n'))
    );
    expect(plan.readers.find((r) => r.file === 'README.md')?.tooBroad).toBe(true);
    expect(plan.readerTests).toEqual(['tests/agents.test.ts']);
  });

  it('limits selections to the paths the CI test suites run', () => {
    const paths = ciTestPaths();
    expect(paths).toEqual(expect.arrayContaining(['libs/core/', 'scripts/', 'tests/']));
    expect(paths.some((entry) => entry.startsWith('-'))).toBe(false);
    expect(isCiTest('tests/smoke.test.ts', paths)).toBe(true);
    expect(isCiTest('presence/displays/concierge/test/a.test.ts', paths)).toBe(false);
    const plan = planAffectedTests({ base: 'origin/main', files: ['AGENTS.md'] }, () =>
      ok('tests/a.test.ts\npresence/displays/concierge/test/b.test.ts\n')
    );
    expect(plan.readerTests).toEqual(['tests/a.test.ts']);
    expect(plan.nonCiReaderTests).toEqual(['presence/displays/concierge/test/b.test.ts']);
  });

  it('drops only the broad needle and keeps exact-path readers', () => {
    const many = Array.from({ length: MAX_READERS_PER_FILE + 1 }, (_, i) => `tests/t${i}.test.ts`);
    const file = 'knowledge/public/locales/messages.ja.json';
    const plan = planAffectedTests({ base: 'origin/main', files: [file] }, (args) =>
      args.includes('messages.ja.json') ? ok(many.join('\n')) : ok('tests/locale.test.ts\n')
    );
    const reader = plan.readers[0]!;
    expect(reader.broadNeedles).toEqual(['messages.ja.json']);
    expect(reader.tooBroad).toBe(false);
    expect(plan.readerTests).toEqual(['tests/locale.test.ts']);
  });

  it('flags vitest rerun triggers and separates deleted code files', () => {
    expect(isVitestRerunTrigger('package.json')).toBe(true);
    expect(isVitestRerunTrigger('libs/core/package.json')).toBe(true);
    expect(isVitestRerunTrigger('vitest.config.mts')).toBe(true);
    expect(isVitestRerunTrigger('scripts/package-json.ts')).toBe(false);
    const plan = planAffectedTests(
      { base: 'origin/main', files: ['libs/core/gone.ts', 'libs/core/kept.ts', 'package.json'] },
      () => ok(''),
      (file) => file !== 'libs/core/gone.ts'
    );
    expect(plan.codeFiles).toEqual(['libs/core/kept.ts']);
    expect(plan.deletedCodeFiles).toEqual(['libs/core/gone.ts']);
    expect(plan.rerunTriggers).toEqual(['package.json']);
  });

  it('matches CI suite paths like vitest filters (case-insensitive substring)', () => {
    expect(isCiTest('libs/shared-x/tests/a.test.ts', ['tests/'])).toBe(true);
    expect(isCiTest('Scripts/A.test.ts', ['scripts/'])).toBe(true);
  });
});
