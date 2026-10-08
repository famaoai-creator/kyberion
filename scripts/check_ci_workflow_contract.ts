/**
 * CI workflow contract (operations-hygiene runbook §CI): keeps the GitHub
 * Actions workflows from drifting back into the 2026-10-08 failure modes.
 *
 * 1. Every job declares `timeout-minutes` (the 360-minute default lets a hung
 *    vitest worker or apt mirror hold a runner for six hours).
 * 2. Every workflow triggered by `pull_request` declares top-level
 *    `concurrency` with `cancel-in-progress`, so a newer push supersedes the
 *    running checks instead of doubling the queue.
 * 3. Actions run on a supported Node runtime: pinned majors must be at least
 *    the first Node24-based major.
 * 4. No job builds `@agent/core` separately before `pnpm run build`, which
 *    already builds every workspace package.
 */
import path from 'node:path';
import * as yaml from 'js-yaml';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/** First major of each action that runs on Node 24. */
export const MIN_ACTION_MAJORS: Readonly<Record<string, number>> = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'actions/upload-artifact': 6,
  'actions/download-artifact': 6,
  'actions/cache': 5,
  'actions/github-script': 8,
  'actions/stale': 10,
  'pnpm/action-setup': 5,
};

const WORKFLOW_DIR = '.github/workflows';
const ACTION_FILES = ['.github/actions/setup-kyberion/action.yml'];

export interface CiWorkflowViolation {
  file: string;
  rule: 'job-timeout' | 'pr-concurrency' | 'action-runtime' | 'redundant-core-build';
  detail: string;
}

type YamlRecord = Record<string, unknown>;

function asRecord(value: unknown): YamlRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as YamlRecord)
    : undefined;
}

function triggersPullRequest(on: unknown): boolean {
  if (on === 'pull_request') return true;
  if (Array.isArray(on)) return on.includes('pull_request');
  return Boolean(asRecord(on) && 'pull_request' in (on as YamlRecord));
}

function collectUses(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUses(item, out);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'uses' && typeof child === 'string') out.push(child);
    else collectUses(child, out);
  }
}

export function checkActionRuntime(file: string, uses: string[]): CiWorkflowViolation[] {
  const violations: CiWorkflowViolation[] = [];
  for (const ref of uses) {
    const match = /^([^@\s]+)@v(\d+)(?:[.\d]*)$/u.exec(ref.trim());
    if (!match) continue;
    const [, action, major] = match;
    const minimum = MIN_ACTION_MAJORS[action!];
    if (minimum !== undefined && Number(major) < minimum) {
      violations.push({
        file,
        rule: 'action-runtime',
        detail: `${ref} runs on a deprecated Node runtime; use ${action}@v${minimum} or later`,
      });
    }
  }
  return violations;
}

export function checkWorkflowDocument(file: string, doc: unknown): CiWorkflowViolation[] {
  const violations: CiWorkflowViolation[] = [];
  const workflow = asRecord(doc);
  if (!workflow) return [{ file, rule: 'job-timeout', detail: 'workflow is not a YAML mapping' }];

  // js-yaml reads the bare key `on` as the boolean true under YAML 1.1 rules.
  const on = workflow.on ?? workflow['true'];
  if (triggersPullRequest(on)) {
    const concurrency = asRecord(workflow.concurrency);
    if (!concurrency || concurrency['cancel-in-progress'] === undefined) {
      violations.push({
        file,
        rule: 'pr-concurrency',
        detail:
          'pull_request workflow needs top-level `concurrency` with `cancel-in-progress` (see the runbook §CI)',
      });
    }
  }

  const jobs = asRecord(workflow.jobs) ?? {};
  for (const [jobId, jobValue] of Object.entries(jobs)) {
    const job = asRecord(jobValue);
    if (!job) continue;
    if (job['timeout-minutes'] === undefined && job.uses === undefined) {
      violations.push({
        file,
        rule: 'job-timeout',
        detail: `job \`${jobId}\` has no timeout-minutes (the 360-minute default can hold a runner for 6 hours)`,
      });
    }
    const runs = (Array.isArray(job.steps) ? job.steps : [])
      .map((step) => asRecord(step)?.run)
      .filter((run): run is string => typeof run === 'string');
    const buildsCoreAlone = runs.some((run) =>
      /pnpm\s+--filter\s+['"]?@agent\/core['"]?\s+(?:run\s+)?build\b/u.test(run)
    );
    const buildsAll = runs.some((run) => /\bpnpm\s+(?:run\s+)?build\s*$/mu.test(run));
    if (buildsCoreAlone && buildsAll) {
      violations.push({
        file,
        rule: 'redundant-core-build',
        detail: `job \`${jobId}\` builds @agent/core before \`pnpm run build\`, which already builds it`,
      });
    }
  }

  const uses: string[] = [];
  collectUses(workflow.jobs, uses);
  violations.push(...checkActionRuntime(file, uses));
  return violations;
}

function readYaml(relativePath: string): unknown {
  const absolute = pathResolver.rootResolve(relativePath);
  if (!safeExistsSync(absolute) || !safeLstat(absolute).isFile()) {
    throw new Error(`${relativePath} must be a regular file`);
  }
  return yaml.load(readTextFile(absolute));
}

export function checkCiWorkflowContract(): CiWorkflowViolation[] {
  const violations: CiWorkflowViolation[] = [];
  const workflowDir = pathResolver.rootResolve(WORKFLOW_DIR);
  const files = safeReaddir(workflowDir)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => path.posix.join(WORKFLOW_DIR, name));
  for (const file of files) violations.push(...checkWorkflowDocument(file, readYaml(file)));
  for (const file of ACTION_FILES) {
    const uses: string[] = [];
    collectUses(asRecord(readYaml(file))?.runs, uses);
    violations.push(...checkActionRuntime(file, uses));
  }
  return violations;
}

export const runCheckCiWorkflowContract = defineScript({
  name: 'check:ci-workflow-contract',
  flags: [],
  run(context) {
    const violations = checkCiWorkflowContract();
    if (violations.length > 0) {
      context.print('[check:ci-workflow-contract] violations detected:');
      for (const violation of violations) {
        context.print(`- ${violation.file} [${violation.rule}]: ${violation.detail}`);
      }
      throw new ScriptExitError(1);
    }
    context.print('[check:ci-workflow-contract] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_ci_workflow_contract.ts') ||
  isDirectScript(import.meta.url, 'check_ci_workflow_contract.js')
)
  void runCheckCiWorkflowContract();
