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
import { safeExec, safeExecResult } from '@agent/core/secure-io';
import { collectChangedFiles, type GitRunner } from './run_checks.js';
import { describeAffectedTestPlan, planAffectedTests } from './lib/affected-tests.js';
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
 * locale (C.UTF-8), CI mode, and no operator persona / role. Without this the
 * operator's profile leaks into the run — e.g. `KYBERION_PERSONA=sovereign`
 * makes locale resolution read the personal identity language (`ja`), and
 * tests asserting the default English vocabulary fail locally but pass in CI.
 * Empty values override the inherited ones (safeExec applies extra env last).
 */
export const AFFECTED_TESTS_ENV = {
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  CI: 'true',
  KYBERION_PERSONA: '',
  MISSION_ROLE: '',
} as const;

export interface AffectedTestsDeps {
  git?: GitRunner;
  /** Runs `pnpm <args>` and throws on failure. */
  run?: (args: string[]) => void;
}

/**
 * Checklist step 3.5: run the tests that import a changed file (vitest
 * `--changed`) and the tests that read a changed data / doc file. Throws on
 * the first failing run; reports what it selected so "0 files" is visible.
 */
export function runAffectedTests(
  print: Print,
  base?: string,
  deps: AffectedTestsDeps = {}
): { codeRun: boolean; readerTests: string[] } {
  const git = deps.git ?? gitRunner;
  const run =
    deps.run ??
    ((args: string[]) => {
      safeExec('pnpm', args, {
        cwd: pathResolver.rootDir(),
        timeoutMs: 1_800_000,
        env: AFFECTED_TESTS_ENV,
      });
    });
  const changed = collectChangedFiles(base, git);
  const plan = planAffectedTests(changed, git);
  for (const line of describeAffectedTestPlan(plan)) print(line);
  const codeRun = plan.codeFiles.length > 0;
  if (codeRun) {
    run([
      'exec',
      'vitest',
      'run',
      '--changed',
      changed.mergeBase,
      '--passWithNoTests',
      ...plan.ciPaths,
    ]);
  }
  if (plan.readerTests.length > 0) {
    run(['exec', 'vitest', 'run', '--passWithNoTests', ...plan.readerTests]);
  }
  if (!codeRun && plan.readerTests.length === 0) {
    print(
      '[pr:affected-tests] No affected tests selected (no code change and no test reads the changed files).'
    );
  } else {
    print('[pr:affected-tests] Affected tests passed.');
  }
  return { codeRun, readerTests: plan.readerTests };
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
