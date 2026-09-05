/**
 * cost_report.ts — OP-01 Task 2 CLI: aggregate the usage ledger into
 * per-mission / per-model / per-day cost views.
 *
 * Usage:
 *   pnpm cost:report                       # all recorded history
 *   pnpm cost:report -- --since 2026-07-01 # window start (ISO date)
 *   pnpm cost:report -- --json             # machine-readable
 */

import { buildCostReportFromHistory, formatCostReport } from '@agent/core/cost-report';
import { logger } from '@agent/core/core';
import type { EventScopeFilter } from '@agent/core/event-scope';
import { createStandardYargs } from '@agent/core/cli-utils';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

export function main(args = currentProcessArgv()): ReturnType<typeof buildCostReportFromHistory> {
  const argv = createStandardYargs(args)
    .option('since', { type: 'string', describe: 'Window start (ISO date/time)' })
    .option('until', { type: 'string', describe: 'Window end (ISO date/time)' })
    .option('last-days', { type: 'number', describe: 'Shorthand: window = now minus N days' })
    .option('tenant', { type: 'string', describe: 'Restrict to one tenant scope' })
    .option('organization-id', { type: 'string', describe: 'Restrict to one organization scope' })
    .option('project-id', { type: 'string', describe: 'Restrict to one project scope' })
    .option('mission-id', { type: 'string', describe: 'Restrict to one mission scope' })
    .option('task-id', { type: 'string', describe: 'Restrict to one task scope' })
    .option('session-id', { type: 'string', describe: 'Restrict to one session scope' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const lastDays = Number(argv['last-days']);
  const since =
    argv.since !== undefined
      ? String(argv.since)
      : Number.isFinite(lastDays) && lastDays > 0
        ? new Date(Date.now() - lastDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
  const scopeFilter: EventScopeFilter = {
    ...(argv.tenant ? { tenant_slug: String(argv.tenant) } : {}),
    ...(argv['organization-id'] ? { organization_id: String(argv['organization-id']) } : {}),
    ...(argv['project-id'] ? { project_id: String(argv['project-id']) } : {}),
    ...(argv['mission-id'] ? { mission_id: String(argv['mission-id']) } : {}),
    ...(argv['task-id'] ? { task_id: String(argv['task-id']) } : {}),
    ...(argv['session-id'] ? { session_id: String(argv['session-id']) } : {}),
  };
  const report = buildCostReportFromHistory({
    since,
    until: argv.until ? String(argv.until) : undefined,
    ...(Object.keys(scopeFilter).length > 0 ? { scopeFilter } : {}),
  });

  if (report.calls === 0) {
    logger.info('[cost-report] no costed usage entries in the window');
  }
  return report;
}

export const runCostReport = defineScript({
  name: 'cost:report',
  flags: ['json'],
  run(context) {
    const report = main(['node', 'cost_report.ts', ...context.argv]);
    context.print(context.json ? report : formatCostReport(report).join('\n'));
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'cost_report.ts') ||
  isDirectScript(import.meta.url, 'cost_report.js')
)
  void runCostReport();
