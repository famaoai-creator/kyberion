import {
  APPROVAL_TRASH_PERSONA_ENV,
  checkApprovalTrashWritable,
  DEFAULT_STALE_PENDING_APPROVAL_MS,
  purgeFixtureApprovals,
  sweepExpirablePendingApprovals,
  sweepExpiredPasskeyChallenges,
  type ApprovalSweepResult,
  type ExpiredPasskeyChallenge,
  type ExpirablePendingApproval,
  type FixtureApprovalRecord,
} from '@agent/core/governance/approval-store-hygiene';
import { listApprovalRequests } from '@agent/core/governance/approval-store';
import { withExecutionContext } from '@agent/core/authority';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * Autonomous-operation P1-2 / P1-4: expire pending approvals nobody will act
 * on and move test-fixture records out of the live approval store.
 *
 * Dry-run by default; `--apply` performs the sweeps (expired passkey
 * challenge files are deleted). Fixture records go to
 * `active/archive/.trash/` (30-day restore window), which only the sovereign
 * persona may write, so `--apply` needs `KYBERION_PERSONA=sovereign`.
 *
 *   node dist/scripts/approval_store_hygiene.js [--stale-days N] [--json]
 *   KYBERION_PERSONA=sovereign node dist/scripts/approval_store_hygiene.js --apply
 */

const APPROVAL_CHANNELS_LOGICAL_DIR = 'active/shared/coordination/channels';

function assertApplyAllowed(): void {
  const access = checkApprovalTrashWritable(APPROVAL_CHANNELS_LOGICAL_DIR);
  if (access.allowed) return;
  throw new ScriptExitError(
    2,
    [
      '--apply moves fixture approvals to active/archive/.trash/, which only the sovereign persona may write.',
      `Rerun as: ${APPROVAL_TRASH_PERSONA_ENV} node dist/scripts/approval_store_hygiene.js --apply`,
      `(${access.reason ?? 'write denied'})`,
    ].join('\n')
  );
}

export interface ApprovalStoreHygieneReport {
  dryRun: boolean;
  staleAfterDays: number;
  pendingExpiry: ApprovalSweepResult<ExpirablePendingApproval>;
  fixturePurge: ApprovalSweepResult<FixtureApprovalRecord>;
  /** Expired passkey challenge files (HA-07). */
  passkeyChallenges?: ApprovalSweepResult<ExpiredPasskeyChallenge>;
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
    lines.push(`  by rule: ${countBy(fixturePurge.candidates, (c) => c.rule)}`);
    lines.push('  (--json lists every record with its title, requester and matched rule)');
  }
  if (!report.dryRun) lines.push(`  trashed: ${fixturePurge.applied.length}`);
  const challenges = report.passkeyChallenges;
  if (challenges) {
    lines.push('', `Expired passkey challenges to remove: ${challenges.candidates.length}`);
    if (!report.dryRun) lines.push(`  removed: ${challenges.applied.length}`);
  }
  const errors = [...pendingExpiry.errors, ...fixturePurge.errors, ...(challenges?.errors ?? [])];
  if (errors.length > 0) {
    lines.push('', `Errors (${errors.length}):`, ...errors.slice(0, 20).map((e) => `  - ${e}`));
  }
  return lines.join('\n');
}

export function runApprovalStoreHygieneSweeps(options: {
  dryRun: boolean;
  staleAfterDays: number;
  /** false skips the trash move (it needs the sovereign persona); expiry still runs. */
  purgeFixtures?: boolean;
}): ApprovalStoreHygieneReport {
  const records = withExecutionContext('mission_controller', () => listApprovalRequests());
  const fixturePurge =
    options.purgeFixtures === false
      ? { candidates: [], applied: [], errors: [], dryRun: options.dryRun }
      : purgeFixtureApprovals({ dryRun: options.dryRun, records });
  const trashed = new Set(fixturePurge.applied);
  const pendingExpiry = sweepExpirablePendingApprovals({
    dryRun: options.dryRun,
    staleAfterMs: options.staleAfterDays * DAY_MS,
    records: records.filter((record) => record.status === 'pending' && !trashed.has(record.id)),
  });
  const passkeyChallenges = sweepExpiredPasskeyChallenges({ dryRun: options.dryRun });
  return {
    dryRun: options.dryRun,
    staleAfterDays: options.staleAfterDays,
    pendingExpiry,
    fixturePurge,
    passkeyChallenges,
  };
}

export const runApprovalStoreHygiene = defineScript({
  name: 'approval-store-hygiene',
  flags: ['json'],
  run(context) {
    const dryRun = !context.argv.includes('--apply');
    const staleAfterDays = readStaleDays(context.argv);
    if (!dryRun) assertApplyAllowed();
    const report = runApprovalStoreHygieneSweeps({ dryRun, staleAfterDays });
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
