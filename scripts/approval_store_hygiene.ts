import {
  DEFAULT_STALE_PENDING_APPROVAL_MS,
  purgeFixtureApprovals,
  sweepExpirablePendingApprovals,
  type ApprovalSweepResult,
  type ExpirablePendingApproval,
  type FixtureApprovalRecord,
} from '@agent/core/approval-store-hygiene';
import { listApprovalRequests } from '@agent/core/approval-store';
import { withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P1-2 / P1-4: expire pending approvals nobody will act
 * on and move test-fixture records out of the live approval store.
 *
 * Dry-run by default; `--apply` performs both sweeps. Fixture records go to
 * `active/archive/.trash/` (30-day restore window), so run `--apply` from an
 * operator session — only that identity may write the trash.
 *
 *   node dist/scripts/approval_store_hygiene.js [--apply] [--stale-days N] [--json]
 */

export interface ApprovalStoreHygieneReport {
  dryRun: boolean;
  staleAfterDays: number;
  pendingExpiry: ApprovalSweepResult<ExpirablePendingApproval>;
  fixturePurge: ApprovalSweepResult<FixtureApprovalRecord>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function readStaleDays(argv: string[]): number {
  const index = argv.indexOf('--stale-days');
  if (index < 0) return DEFAULT_STALE_PENDING_APPROVAL_MS / DAY_MS;
  const raw = argv[index + 1];
  const days = Number(raw);
  if (!raw || !Number.isInteger(days) || days < 1) {
    throw new ScriptExitError(2, `--stale-days requires a positive integer, got: ${raw ?? ''}`);
  }
  return days;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
}

export function formatApprovalStoreHygieneReport(report: ApprovalStoreHygieneReport): string {
  const mode = report.dryRun ? 'dry-run (pass --apply to act)' : 'applied';
  const { pendingExpiry, fixturePurge } = report;
  const lines = [
    `Approval store hygiene — ${mode}`,
    '',
    `Pending to expire: ${pendingExpiry.candidates.length} (stale after ${report.staleAfterDays}d without expiresAt)`,
  ];
  if (pendingExpiry.candidates.length > 0) {
    lines.push(`  by reason: ${countBy(pendingExpiry.candidates, (c) => c.reason)}`);
    lines.push(`  by channel: ${countBy(pendingExpiry.candidates, (c) => c.storageChannel)}`);
  }
  if (!report.dryRun) lines.push(`  expired: ${pendingExpiry.applied.length}`);
  lines.push('', `Fixture records to trash: ${fixturePurge.candidates.length}`);
  if (fixturePurge.candidates.length > 0) {
    lines.push(`  by channel: ${countBy(fixturePurge.candidates, (c) => c.storageChannel)}`);
  }
  if (!report.dryRun) lines.push(`  trashed: ${fixturePurge.applied.length}`);
  const errors = [...pendingExpiry.errors, ...fixturePurge.errors];
  if (errors.length > 0) {
    lines.push('', `Errors (${errors.length}):`, ...errors.slice(0, 20).map((e) => `  - ${e}`));
  }
  return lines.join('\n');
}

export function runApprovalStoreHygieneSweeps(options: {
  dryRun: boolean;
  staleAfterDays: number;
}): ApprovalStoreHygieneReport {
  const records = withExecutionContext('mission_controller', () => listApprovalRequests());
  const fixturePurge = purgeFixtureApprovals({ dryRun: options.dryRun, records });
  const trashed = new Set(fixturePurge.applied);
  const pendingExpiry = sweepExpirablePendingApprovals({
    dryRun: options.dryRun,
    staleAfterMs: options.staleAfterDays * DAY_MS,
    records: records.filter((record) => record.status === 'pending' && !trashed.has(record.id)),
  });
  return {
    dryRun: options.dryRun,
    staleAfterDays: options.staleAfterDays,
    pendingExpiry,
    fixturePurge,
  };
}

export const runApprovalStoreHygiene = defineScript({
  name: 'approval-store-hygiene',
  flags: ['json'],
  run(context) {
    const report = runApprovalStoreHygieneSweeps({
      dryRun: !context.argv.includes('--apply'),
      staleAfterDays: readStaleDays(context.argv),
    });
    context.print(
      context.json ? JSON.stringify(report, null, 2) : formatApprovalStoreHygieneReport(report)
    );
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'approval_store_hygiene.ts') ||
  isDirectScript(import.meta.url, 'approval_store_hygiene.js')
)
  void runApprovalStoreHygiene();
