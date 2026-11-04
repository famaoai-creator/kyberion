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
import type { VcsCommandRunner } from '@agent/core/vcs';
import { VcsHostError } from '@agent/core/vcs/vcs-host';
import {
  vcsHostOptionsForRunner,
  vcsHostPrChecks,
  vcsHostPrList,
  vcsHostPrViewFields,
} from '@agent/core/vcs/vcs-host-verbs';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P2, shadow mode: observe pull requests and report how
 * the autonomy gate's verdicts compare with what the operator actually did.
 *
 *   node dist/scripts/pr_shadow.js observe [--ignore-check <name>]... [--json]
 *   node dist/scripts/pr_shadow.js report [--json]
 *
 * `observe` only READS GitHub (PR list/view/checks via the vcs-host seam) and appends to the
 * shadow ledger; it never merges, comments or edits a PR. Run it on a schedule
 * (`pipelines/pr-shadow-observer.json`) for a few weeks, then read `report`.
 * See libs/core/governance/pr-shadow.ts.
 */

type GhRunner = (args: string[]) => { stdout: string; status: number | null };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read port over the governed vcs-host seam (gh-cli by default, github-rest
 * where gh is absent). An injected `run` keeps driving a gh CLI built on it —
 * the argv-level seam the tests use. Credentials come from registered env.
 */
export function createGhPrPort(run?: GhRunner): PrReadPort {
  const exec: VcsCommandRunner | undefined = run
    ? (_command, args) => {
        const out = run(args);
        return { stdout: out.stdout, stderr: '', status: out.status };
      }
    : undefined;
  const host = vcsHostOptionsForRunner({ cwd: pathResolver.rootDir() }, exec);
  return {
    async listOpen(): Promise<PrSummary[]> {
      return (await vcsHostPrList({ ...host, state: 'open', limit: 100 })).map((entry) => ({
        number: Number(entry.number),
        title: String(entry.title ?? ''),
        headSha: String(entry.headRefOid ?? ''),
        isDraft: entry.isDraft === true,
        author: String(entry.author?.login ?? '') || undefined,
      }));
    },
    async files(prNumber: number): Promise<PrFile[]> {
      const { files } = await vcsHostPrViewFields({
        ...host,
        ref: String(prNumber),
        fields: 'files',
      });
      return (Array.isArray(files) ? files : []).map((entry) => {
        const record = asRecord(entry);
        return {
          path: String(record.path ?? ''),
          additions: Number(record.additions ?? 0),
          deletions: Number(record.deletions ?? 0),
        };
      });
    },
    async ciState(prNumber: number, ignoredChecks: readonly string[]) {
      // Shadow mode keeps the original leniency for command failures (no
      // checks / unreadable output → 'none', never a blocker) — but a
      // well-formed response whose payload doesn't parse is a different
      // failure class: fail closed so a gh upgrade can't silently mask CI.
      let result;
      try {
        result = await vcsHostPrChecks({
          ...host,
          ref: String(prNumber),
          ignore: [...ignoredChecks],
        });
      } catch (error) {
        if (error instanceof VcsHostError && error.code === 'invalid') {
          return { state: 'failure' as PrCiState, failing: ['gh-pr-checks-parse'] };
        }
        return { state: 'none' as PrCiState, failing: [] };
      }
      if (result.state === 'none') return { state: 'none' as PrCiState, failing: [] };
      return { state: result.state as PrCiState, failing: result.failing };
    },
    async finalState(prNumber: number): Promise<PrFinalState> {
      const record = await vcsHostPrViewFields({
        ...host,
        ref: String(prNumber),
        fields: 'state,mergedAt,closedAt',
      });
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
  async run(context) {
    const first = context.argv[0];
    const command = first && !first.startsWith('--') ? first : 'report';
    if (command === 'observe') {
      const result = await observePullRequests(createGhPrPort(), {
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
