/**
 * cost_report.ts — OP-01 Task 2 CLI: aggregate the usage ledger into
 * per-mission / per-model / per-day cost views.
 *
 * Usage:
 *   pnpm cost:report                       # all recorded history
 *   pnpm cost:report -- --since 2026-07-01 # window start (ISO date)
 *   pnpm cost:report -- --json             # machine-readable
 */

import { buildCostReportFromHistory, formatCostReport, logger } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

function main(): number {
  const argv = createStandardYargs()
    .option('since', { type: 'string', describe: 'Window start (ISO date/time)' })
    .option('until', { type: 'string', describe: 'Window end (ISO date/time)' })
    .option('last-days', { type: 'number', describe: 'Shorthand: window = now minus N days' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const lastDays = Number(argv['last-days']);
  const since =
    argv.since !== undefined
      ? String(argv.since)
      : Number.isFinite(lastDays) && lastDays > 0
        ? new Date(Date.now() - lastDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
  const report = buildCostReportFromHistory({
    since,
    until: argv.until ? String(argv.until) : undefined,
  });

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatCostReport(report)) console.log(line);
  }
  if (report.calls === 0) {
    logger.info('[cost-report] no costed usage entries in the window');
  }
  return 0;
}

const isDirect = process.argv[1] && /cost_report\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  process.exit(main());
}
