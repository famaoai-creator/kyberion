import { parseSafeJsonInput } from '@agent/core/foundation';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import {
  DEFAULT_IGNORED_CHECKS,
  listPrShadowRecords,
  observePullRequests,
  summarizePrShadow,
  type ObserveResult,
  type PrCiState,
  type PrFile,
  type PrFinalState,
  type PrReadPort,
  type PrShadowSummary,
  type PrSummary,
} from '@agent/core/governance/pr-shadow';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P2, shadow mode: observe pull requests and report how
 * the autonomy gate's verdicts compare with what the operator actually did.
 *
 *   node dist/scripts/pr_shadow.js observe [--ignore-check <name>]... [--json]
 *   node dist/scripts/pr_shadow.js report [--json]
 *
 * `observe` only READS GitHub (`gh pr list|view|checks`) and appends to the
 * shadow ledger; it never merges, comments or edits a PR. Run it on a schedule
 * (`pipelines/pr-shadow-observer.json`) for a few weeks, then read `report`.
 * See libs/core/governance/pr-shadow.ts.
 */

type GhRunner = (args: string[]) => { stdout: string; status: number | null };

/** Credentials are explicit overrides for gh only, never general child inheritance. */
function runGh(args: string[]): { stdout: string; status: number | null } {
  const result = safeExecResult('gh', args, {
    cwd: pathResolver.rootDir(),
    env: {
      GH_TOKEN: getRegisteredEnvText('GH_TOKEN'),
      GITHUB_TOKEN: getRegisteredEnvText('GITHUB_TOKEN'),
    },
  });
  return { stdout: result.stdout, status: result.status };
}

function parseJson<T>(raw: string, label: string): T {
  return parseSafeJsonInput(raw, label) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createGhPrPort(run: GhRunner = runGh): PrReadPort {
  const view = (prNumber: number, fields: string): Record<string, unknown> => {
    const out = run(['pr', 'view', String(prNumber), '--json', fields]);
    if (out.status !== 0) throw new Error(`gh pr view #${prNumber} exited ${out.status}`);
    return asRecord(parseJson(out.stdout, `gh pr view #${prNumber}`));
  };
  return {
    listOpen(): PrSummary[] {
      const out = run([
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,headRefOid,isDraft,author',
      ]);
      if (out.status !== 0) throw new Error(`gh pr list exited ${out.status}`);
      return parseJson<unknown[]>(out.stdout, 'gh pr list').map((entry) => {
        const record = asRecord(entry);
        return {
          number: Number(record.number),
          title: String(record.title ?? ''),
          headSha: String(record.headRefOid ?? ''),
          isDraft: record.isDraft === true,
          author: String(asRecord(record.author).login ?? '') || undefined,
        };
      });
    },
    files(prNumber: number): PrFile[] {
      const files = view(prNumber, 'files').files;
      return (Array.isArray(files) ? files : []).map((entry) => {
        const record = asRecord(entry);
        return {
          path: String(record.path ?? ''),
          additions: Number(record.additions ?? 0),
          deletions: Number(record.deletions ?? 0),
        };
      });
    },
    ciState(prNumber: number, ignoredChecks: readonly string[]) {
      // `gh pr checks` exits non-zero while checks fail or are pending; the JSON is still valid.
      const out = run(['pr', 'checks', String(prNumber), '--json', 'name,bucket']);
      if (!out.stdout.trim()) return { state: 'none' as PrCiState, failing: [] };
      const checks = parseJson<unknown[]>(out.stdout, `gh pr checks #${prNumber}`)
        .map(asRecord)
        .filter((check) => !ignoredChecks.includes(String(check.name)));
      if (checks.length === 0) return { state: 'none' as PrCiState, failing: [] };
      const failing = checks
        .filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
        .map((check) => String(check.name));
      if (failing.length > 0) return { state: 'failure' as PrCiState, failing };
      const pending = checks.some((check) => check.bucket === 'pending');
      return { state: (pending ? 'pending' : 'success') as PrCiState, failing: [] };
    },
    finalState(prNumber: number): PrFinalState {
      const record = view(prNumber, 'state,mergedAt,closedAt');
      const state = String(record.state ?? '').toUpperCase();
      if (state === 'MERGED')
        return { state: 'merged', at: String(record.mergedAt ?? '') || undefined };
      if (state === 'CLOSED')
        return { state: 'closed', at: String(record.closedAt ?? '') || undefined };
      return { state: 'open' };
    },
  };
}

function readIgnoredChecks(argv: string[]): string[] {
  const extra: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--ignore-check') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new ScriptExitError(2, '--ignore-check requires a check name');
    extra.push(value);
  }
  return [...DEFAULT_IGNORED_CHECKS, ...extra];
}

export function formatPrShadowSummary(summary: PrShadowSummary): string {
  const lines = [
    `PR shadow report — ${summary.observed_prs} observed, ${summary.settled_prs} settled`,
  ];
  for (const tier of summary.by_tier) {
    lines.push(
      `  ${tier.tier}: settled ${tier.settled} (merged ${tier.merged}, closed ${tier.closed}); agreed ${tier.agreed}, false positive ${tier.false_positive}, merged despite CI ${tier.merged_despite_ci}`,
      `    ${summary.readiness[tier.tier]}`
    );
  }
  lines.push(
    '',
    'Shadow mode only: nothing was merged, commented or changed. A "false positive" is a PR the gate',
    'would have auto-merged (given review evidence) that the operator closed instead.'
  );
  return lines.join('\n');
}

export function formatObserveResult(result: ObserveResult): string {
  const lines = [
    `PR shadow observe — recorded ${result.observed}, unchanged ${result.unchanged}, settled ${result.outcomes}, drafts skipped ${result.skippedDrafts}`,
  ];
  for (const error of result.errors.slice(0, 10)) lines.push(`  error: ${error}`);
  return lines.join('\n');
}

export const runPrShadow = defineScript({
  name: 'pr-shadow',
  flags: ['json'],
  run(context) {
    const first = context.argv[0];
    const command = first && !first.startsWith('--') ? first : 'report';
    if (command === 'observe') {
      const result = observePullRequests(createGhPrPort(), {
        ignoredChecks: readIgnoredChecks(context.argv),
      });
      context.print(context.json ? JSON.stringify(result, null, 2) : formatObserveResult(result));
      return result;
    }
    if (command === 'report') {
      const summary = summarizePrShadow(listPrShadowRecords());
      context.print(
        context.json ? JSON.stringify(summary, null, 2) : formatPrShadowSummary(summary)
      );
      return summary;
    }
    throw new ScriptExitError(2, `Unknown pr-shadow command: ${command} (observe | report)`);
  },
});

if (
  isDirectScript(import.meta.url, 'pr_shadow.ts') ||
  isDirectScript(import.meta.url, 'pr_shadow.js')
)
  void runPrShadow();
