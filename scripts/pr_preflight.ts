#!/usr/bin/env node
/**
 * `pnpm kyberion pr preflight` — the `pr create` readiness gates without
 * creating a pull request (dev-cycle plan M1).
 *
 * An implementer (or a dedicated preflight agent) runs this before `git push`
 * so the branch reaches CI with the same evidence `pr create` would demand:
 * the PR title policy, `pnpm check -- --changed` (every pr gate plus the
 * full-only gates whose `paths` match the changed files), the affected tests
 * (checklist step 3.5: `vitest run --changed <base>` for code plus the tests
 * that read changed data / doc files, see lib/affected-tests.ts), and — when a
 * body file is given — the KL-03 Knowledge-in-PR check. Nothing here talks to gh.
 */

import {
  parsePublishArgs,
  PRE_PR_READINESS_CHECKLIST,
  resolveKnowledgeDiffBase,
  resolvePublishTitle,
  runKnowledgeReadinessGate,
  runPrePrReadiness,
} from './publish_pull_request.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync } from '@agent/core/secure-io';
import { collectChangedFiles, type GitRunner } from './run_checks.js';
import { describeAffectedTestPlan, planAffectedTests } from './lib/affected-tests.js';
import { TEST_SUITES } from './test_suite.js';
import { defineScript, isDirectScript } from './lib/harness.js';
import { guardCliArgsNormalized, type CliGuardSpec } from './lib/cli-guard.js';

type Print = (value: unknown) => void;

export const PREFLIGHT_PR_CLI: CliGuardSpec = {
  command: 'pnpm kyberion pr preflight',
  manifestId: 'script.pr.preflight',
  options: [
    { flag: '--title', value: '<conventional title>' },
    { flag: '--body-file', value: '<path>' },
    { flag: '--base', value: '<branch>' },
    { flag: '--mission-root', value: '<path>' },
    { flag: '--check-jobs', value: '<1..6>' },
    { flag: '--skip-affected-tests' },
  ],
};

const gitRunner: GitRunner = (args) =>
  safeExecResult('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 60_000,
  });

/**
 * The CI test environment (checklist locale row): the GitHub-hosted runner's
 * locale (C.UTF-8), CI mode, strict leak checking (as the test workflows set
 * it), and no operator persona / role / mission / sudo. Without this the
 * operator's profile leaks into the run — e.g. `KYBERION_PERSONA=sovereign`
 * makes locale resolution read the personal identity language (`ja`), and
 * tests asserting the default English vocabulary fail locally but pass in CI.
 * Empty values override the inherited ones (safeExecResult applies extra env
 * last; getRegisteredEnv treats '' as unset).
 */
export const AFFECTED_TESTS_ENV = {
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  CI: 'true',
  KYBERION_TEST_LEAK_STRICT: '1',
  KYBERION_PERSONA: '',
  MISSION_ROLE: '',
  MISSION_ID: '',
  KYBERION_SUDO: '',
} as const;

export interface VitestRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AffectedTestsDeps {
  git?: GitRunner;
  /** Runs vitest with these arguments (the part after `vitest`). */
  vitest?: (args: string[]) => VitestRunResult;
  exists?: (file: string) => boolean;
}

/** Same budget as scripts/test_suite.ts: broad runs stream for 20min+. */
const VITEST_TIMEOUT_MS = 2_400_000;
const VITEST_MAX_OUTPUT_MB = 50;

function runVitest(args: string[]): VitestRunResult {
  const entry = pathResolver.rootResolve('node_modules/vitest/vitest.mjs');
  return safeExecResult(process.execPath, [entry, ...args], {
    cwd: pathResolver.rootDir(),
    env: AFFECTED_TESTS_ENV,
    timeoutMs: VITEST_TIMEOUT_MS,
    maxOutputMB: VITEST_MAX_OUTPUT_MB,
  });
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');

/** Vitest summary lines (Test Files / Tests / No test files) and the test file count. */
export function summarizeVitestOutput(output: string): { lines: string[]; testFiles: number } {
  const lines = output
    .replace(ANSI_PATTERN, '')
    .split('\n')
    .map((line) => line.trim());
  const summary = lines.filter(
    (line) => /^(?:Test Files|Tests)\s/u.test(line) || line.includes('No test files found')
  );
  const files = lines
    .map((line) => /^Test Files\s.*\((\d+)\)\s*$/u.exec(line))
    .find((match) => match !== null);
  return { lines: summary, testFiles: files ? Number(files[1]) : 0 };
}

export interface AffectedTestsResult {
  testFiles: number;
  readerTests: string[];
  /** Selections that could not be run, with the reason (record in the Test plan). */
  notRun: string[];
}

/** Ownership, not a substring such as tests/fixtures/libs/core/. */
export function isCoreAffectedTest(file: string): boolean {
  return TEST_SUITES.core
    .filter((entry) => !entry.startsWith('-'))
    .some((prefix) => file.startsWith(prefix));
}

export const CORE_AFFECTED_TEST_EXCLUDES = ['libs/core/**', 'libs/shared-*/**'] as const;

/**
 * Checklist step 3.5: run the tests that import a changed file (vitest
 * `--changed`, limited to the CI suites) and the tests that read a changed
 * data / doc file. Throws on a failing run. Reports how many test files ran,
 * so an empty selection is never shown as a pass.
 */
export function runAffectedTests(
  print: Print,
  base?: string,
  deps: AffectedTestsDeps = {}
): AffectedTestsResult {
  const git = deps.git ?? gitRunner;
  const vitest = deps.vitest ?? runVitest;
  const exists = deps.exists ?? ((file: string) => safeExistsSync(pathResolver.rootResolve(file)));
  const changed = collectChangedFiles(base, git);
  const plan = planAffectedTests(changed, git, exists);
  for (const line of describeAffectedTestPlan(plan)) print(line);

  const notRun: string[] = [];
  const failures: string[] = [];
  let testFiles = 0;
  const runSelection = (label: string, args: string[]) => {
    print(`[pr:affected-tests] ${label}: vitest ${args.join(' ')}`);
    let result: VitestRunResult;
    try {
      result = vitest(args);
    } catch (cause) {
      failures.push(
        `[pr:affected-tests] ${label} tests failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      return;
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const summary = summarizeVitestOutput(output);
    for (const line of summary.lines) print(`[pr:affected-tests]   ${line}`);
    if (result.status !== 0) {
      const lines = output.replace(ANSI_PATTERN, '').trim().split('\n');
      // A long failure list must retain every failing case, not just the last
      // stack trace: the broad run may take many minutes to reproduce.
      const failingCases = lines.flatMap((line, index) =>
        /^\s*FAIL\s/u.test(line) ? lines.slice(index, index + 3) : []
      );
      const tail = [...failingCases, ...lines.slice(-40)].join('\n');
      failures.push(
        `[pr:affected-tests] ${label} tests failed (exit ${String(result.status)})\n${tail}`
      );
      return;
    }
    testFiles += summary.testFiles;
  };

  let runCode = false;
  if (plan.codeFiles.length > 0 || plan.deletedCodeFiles.length > 0) {
    if (plan.rerunTriggers.length > 0) {
      notRun.push(
        `code tests: ${plan.rerunTriggers.join(', ')} changed, so vitest --changed would rerun every test; run the owning suites (pnpm test -- --suite <name>) instead`
      );
    } else {
      runCode = true;
    }
  }
  const coreFlags = TEST_SUITES.core.filter((entry) => entry.startsWith('-'));
  if (runCode)
    runSelection('core code', [
      'run',
      '--changed',
      changed.mergeBase,
      '--passWithNoTests',
      ...TEST_SUITES.core,
    ]);
  const coreReaders = plan.readerTests.filter(isCoreAffectedTest);
  const nonCoreReaders = plan.readerTests.filter((file) => !isCoreAffectedTest(file));
  if (coreReaders.length > 0)
    runSelection('core readers', ['run', '--passWithNoTests', ...coreReaders, ...coreFlags]);
  if (runCode)
    runSelection('non-core code', [
      'run',
      '--changed',
      changed.mergeBase,
      '--passWithNoTests',
      ...plan.ciPaths,
      ...CORE_AFFECTED_TEST_EXCLUDES.flatMap((glob) => ['--exclude', glob]),
    ]);
  if (nonCoreReaders.length > 0)
    runSelection('non-core readers', ['run', '--passWithNoTests', ...nonCoreReaders]);
  const broad = plan.readers.filter((reader) => reader.tooBroad).map((reader) => reader.file);
  if (broad.length > 0) notRun.push(`readers of ${broad.join(', ')}: too broad to select`);
  if (plan.nonCiReaderTests.length > 0) {
    notRun.push(`${plan.nonCiReaderTests.length} reader test(s) outside the CI suites`);
  }

  for (const reason of notRun) print(`[pr:affected-tests] NOT RUN — ${reason}`);
  if (failures.length > 0) throw new Error(failures.join('\n\n'));
  if (testFiles === 0) {
    print(
      '[pr:affected-tests] 0 test files ran — no test verified this change; record that in the PR Test plan.'
    );
  } else {
    print(
      `[pr:affected-tests] Affected tests passed (${testFiles} test file(s))${notRun.length > 0 ? '; see NOT RUN above' : ''}.`
    );
  }
  return { testFiles, readerTests: plan.readerTests, notRun };
}

export async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const guarded = guardCliArgsNormalized(argv, PREFLIGHT_PR_CLI, print);
  if (guarded.handled) return;
  const options = parsePublishArgs(guarded.argv);

  const title = resolvePublishTitle(options.title);
  print(`[pr:preflight] PR title OK: ${title}`);

  runPrePrReadiness(print, options.checkJobs, options.base);

  if (options.skipAffectedTests) {
    print(
      '[pr:preflight] Affected tests skipped (--skip-affected-tests): record them as not run in the PR Test plan.'
    );
  } else {
    runAffectedTests(print, options.base ? resolveKnowledgeDiffBase(options.base) : undefined);
  }

  if (options.bodyFile) {
    runKnowledgeReadinessGate(options);
    print('[pr:preflight] Knowledge readiness check passed (KL-03).');
  } else {
    print(
      '[pr:preflight] Knowledge readiness (KL-03) not checked: pass --body-file <filled PR template> to include it.'
    );
  }
  print(
    `[pr:preflight] Ready to push. Remaining manual rows: ${PRE_PR_READINESS_CHECKLIST} (exception table).`
  );
}

const script = defineScript({
  name: 'pr:preflight',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'pr_preflight.ts') ||
  isDirectScript(import.meta.url, 'pr_preflight.js')
) {
  void script();
}
