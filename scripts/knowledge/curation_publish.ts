#!/usr/bin/env node
/**
 * `pnpm kyberion knowledge curation-publish` — turn the weekly generated
 * `CURATION_REPORT.md` into a `chore(knowledge)` PR, per the publication
 * contract documented in the knowledge_steward procedure (Pilot #3): the
 * pipeline leaves the artifact uncommitted and each run lands via a PR.
 *
 * The command performs the mechanical part only — branch, single-file
 * commit, push — then delegates to `pr create`, so the readiness gate,
 * KL-03 knowledge readiness and the human approval gate all still apply.
 * It never commits anything but the report file and never calls `gh`
 * directly.
 *
 * Flags: --report <repo-relative path> · --date <YYYY-MM-DD> ·
 *        --base <branch> · --dry-run · --force
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeReadFile,
  safeSpawn,
  safeWriteFile,
} from '@agent/core/secure-io';
import { defineScript, isDirectScript } from '../lib/harness.js';
import { guardCliArgsNormalized, type CliGuardSpec } from '../lib/cli/cli-guard.js';

type Print = (value: unknown) => void;

const CURATION_PUBLISH_CLI: CliGuardSpec = {
  command: 'pnpm kyberion knowledge curation-publish',
  manifestId: 'script.knowledge.curation-publish',
  options: [
    { flag: '--report', value: '<repo-relative path>' },
    { flag: '--date', value: '<YYYY-MM-DD>' },
    { flag: '--base', value: '<branch>' },
    { flag: '--dry-run' },
    { flag: '--force' },
  ],
};

const DEFAULT_REPORT = 'knowledge/product/governance/CURATION_REPORT.md';
const BRANCH_PREFIX = 'chore/knowledge-curation-';

interface PublishOptions {
  report: string;
  date?: string;
  base: string;
  dryRun: boolean;
  force: boolean;
}

export function parseArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = {
    report: DEFAULT_REPORT,
    base: 'main',
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--report') options.report = argv[++i] ?? options.report;
    else if (arg === '--date') options.date = argv[++i];
    else if (arg === '--base') options.base = argv[++i] ?? options.base;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
  }
  return options;
}

/** `generated_at: 2026-11-21T03:00:00…` → `2026-11-21`. */
export function reportDate(markdown: string): string | undefined {
  return /^generated_at:\s*(\d{4}-\d{2}-\d{2})/m.exec(markdown)?.[1];
}

export function branchName(date: string): string {
  return `${BRANCH_PREFIX}${date.replace(/-/g, '')}`;
}

export function commitMessage(date: string): string {
  return `chore(knowledge): weekly curation report ${date}`;
}

export function renderBody(date: string, reportPath: string): string {
  return `## Summary

Weekly knowledge-curation scan artifact (\`${reportPath}\`, generated ${date}). Advisory only — KM-03: the report proposes candidates; no file is deleted, archived, or demoted automatically. See \`knowledge/product/roles/knowledge_steward/PROCEDURE.md\`.

## Coordination

- Mission ID: none
- Workitem IDs:
- Evidence paths: ${reportPath}
- Trace IDs:
- Related workflow doc: pipelines/knowledge-curation-weekly.json

## Knowledge

- none — weekly advisory artifact; steward-gated promotions happen through their own approval flow
`;
}

interface GitPlan {
  branch: string;
  message: string;
  report: string;
  clean: boolean;
  modified: string[];
}

function git(args: string[]): string {
  return safeExec('git', args, { cwd: pathResolver.rootDir() }).trim();
}

function gitLines(args: string[]): string[] {
  // No trailing trim: porcelain pads each line with a two-column status
  // prefix, and trimming the whole output would eat the first entry's.
  return safeExec('git', args, { cwd: pathResolver.rootDir() })
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** `XY <path>` / `XY <old> -> <new>` porcelain line → path. */
export function porcelainPath(line: string): string {
  const rest = line.slice(2).trim();
  return rest.includes(' -> ') ? rest.slice(rest.indexOf(' -> ') + 4) : rest;
}

/** Inspect the worktree: the report must be the only modified tracked file. */
function inspectWorktree(report: string, date: string): GitPlan {
  const modified = gitLines(['status', '--porcelain', '--untracked-files=no']).map(porcelainPath);
  return {
    branch: branchName(date),
    message: commitMessage(date),
    report,
    clean: modified.length === 0,
    modified,
  };
}

export async function main(argv: string[], print: Print = () => undefined): Promise<void> {
  const guarded = guardCliArgsNormalized(argv, CURATION_PUBLISH_CLI, print);
  if (guarded.handled) return;
  const options = parseArgs(guarded.argv);
  const root = pathResolver.rootDir();

  const reportPath = assertSafeRepositoryPath(options.report);
  if (!safeExistsSync(reportPath))
    throw new Error(`curation report not found: ${options.report} — run the weekly pipeline first`);

  const markdown = String(safeReadFile(reportPath));
  const date = options.date ?? reportDate(markdown);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error(`cannot determine report date — pass --date <YYYY-MM-DD>`);

  const plan = inspectWorktree(options.report, date);
  const others = plan.modified.filter((f) => f !== options.report && f !== `./${options.report}`);
  if (others.length > 0)
    throw new Error(
      `worktree has unrelated modifications — refusing to publish: ${others.join(', ')}`
    );
  if (plan.clean && !options.force)
    throw new Error(
      `curation report is unmodified vs HEAD — nothing to publish (use --force to republish anyway)`
    );

  const title = commitMessage(date);
  const bodyFile = 'active/shared/tmp/curation-pr-body.md';
  const steps = [
    `git checkout -B ${plan.branch}`,
    `git add ${plan.report}`,
    `git commit -m "${plan.message}"`,
    `git push -u origin ${plan.branch}`,
    `pr create --title "${title}" --body-file ${bodyFile} --base ${options.base}`,
  ];
  if (options.dryRun) {
    print(`[curation-publish] dry-run — report=${plan.report} date=${date} branch=${plan.branch}`);
    for (const step of steps) print(`  ${step}`);
    return;
  }

  git(['checkout', '-B', plan.branch]);
  try {
    git(['add', plan.report]);
    git(['commit', '-m', plan.message]);
    git(['push', '-u', 'origin', plan.branch]);

    const bodyPath = assertSafeRepositoryPath(bodyFile, { allowMissingLeaf: true });
    safeWriteFile(bodyPath, renderBody(date, options.report));

    // Delegate to the governed pr create path: readiness gate, KL-03 and the
    // human approval gate all still apply inside the child process.
    const distCli = path.join(root, 'dist', 'scripts', 'kyberion.js');
    const status = await new Promise<number>((resolvePromise, reject) => {
      const child = safeSpawn(
        process.execPath,
        [
          distCli,
          'pr',
          'create',
          '--title',
          title,
          '--body-file',
          bodyFile,
          '--base',
          options.base,
        ],
        { stdio: 'inherit', cwd: root }
      );
      child.on('exit', (code) => resolvePromise(code ?? 1));
      child.on('error', reject);
    });
    if (status !== 0)
      throw new Error(
        `pr create exited ${status} — approve the request and re-run, or create the PR manually for ${plan.branch}`
      );
    print(`[curation-publish] published ${plan.report} via ${plan.branch}`);
  } finally {
    // Return the checkout to its prior branch; the pushed branch carries the commit.
    git(['checkout', '-']);
  }
}

const script = defineScript({
  name: 'knowledge:curation-publish',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});
if (
  isDirectScript(import.meta.url, 'curation_publish.ts') ||
  isDirectScript(import.meta.url, 'curation_publish.js')
) {
  void script();
}
