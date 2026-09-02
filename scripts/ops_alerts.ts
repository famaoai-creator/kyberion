#!/usr/bin/env node
/**
 * scripts/ops_alerts.ts — LC-02a: undelivered-alert triage CLI.
 *
 * The ops-alert JSONL sink accumulates alerts and undelivered operator
 * notifications that nobody sees until a channel is configured. This CLI
 * makes the backlog visible and actionable:
 *
 *   pnpm ops:alerts                          # summary (counts, oldest/newest, top categories)
 *   pnpm ops:alerts -- --json                # machine-readable summary
 *   pnpm ops:alerts -- --redeliver           # re-send outstanding records via the webhook
 *   pnpm ops:alerts -- --redeliver --limit 5 # cap a redelivery batch
 *   pnpm ops:alerts -- --ack                 # acknowledge all outstanding records
 *   pnpm ops:alerts -- --ack --before <iso>  # acknowledge records older than <iso>
 *
 * The log is append-only history: redelivery and acknowledgement append new
 * receipt records referencing originals — existing lines are never rewritten.
 */
import {
  acknowledgeOpsAlerts,
  readOpsAlertLogRecords,
  redeliverUndeliveredOpsAlerts,
  summarizeOpsAlertLog,
  OPS_ALERT_WEBHOOK_ENV,
  type OpsAlertLogSummary,
} from '@agent/core/ops-alert';
import { enqueueOperationalLearningSignal } from '@agent/core/operational-learning';
import { nowIso } from '@agent/core/foundation';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

export function formatOpsAlertSummary(summary: OpsAlertLogSummary): string[] {
  const lines: string[] = [];
  lines.push(`Ops-alert log: ${summary.total_records} record(s)`);
  for (const [kind, count] of Object.entries(summary.by_kind)) {
    lines.push(`  - ${kind}: ${count}`);
  }
  lines.push(
    `Alerts emitted: ${summary.alerts.total} (suppressed: ${summary.alerts.suppressed}; ` +
      `by severity: ${JSON.stringify(summary.alerts.by_severity)})`
  );
  const undelivered = summary.undelivered;
  lines.push(
    `Undelivered notifications: ${undelivered.total} total — ` +
      `${undelivered.outstanding} outstanding, ${undelivered.redelivered} redelivered, ` +
      `${undelivered.acknowledged} acknowledged`
  );
  if (undelivered.outstanding > 0) {
    lines.push(`  oldest outstanding: ${undelivered.oldest_outstanding}`);
    lines.push(`  newest outstanding: ${undelivered.newest_outstanding}`);
    lines.push(`  by reason: ${JSON.stringify(undelivered.by_reason)}`);
    lines.push(`  by event: ${JSON.stringify(undelivered.by_event)}`);
  }
  if (summary.top_categories.length > 0) {
    lines.push('Top categories:');
    for (const entry of summary.top_categories) {
      lines.push(`  - ${entry.category}: ${entry.count}`);
    }
  }
  if (undelivered.outstanding > 0) {
    lines.push(
      `Next: set ${OPS_ALERT_WEBHOOK_ENV} then \`pnpm ops:alerts -- --redeliver\`, ` +
        'or `pnpm ops:alerts -- --ack` to acknowledge the backlog.'
    );
  }
  return lines;
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined,
  json = args.includes('--json')
): Promise<void> {
  const argv = await createStandardYargs(['node', 'ops_alerts', ...stripSharedScriptFlags(args)])
    .option('redeliver', {
      type: 'boolean',
      default: false,
      describe: 'Re-send outstanding undelivered records through the configured webhook',
    })
    .option('ack', {
      type: 'boolean',
      default: false,
      describe: 'Append an acknowledgement covering outstanding undelivered records',
    })
    .option('before', {
      type: 'string',
      describe: 'With --ack: only acknowledge records with a timestamp <= this ISO instant',
    })
    .option('limit', {
      type: 'number',
      describe: 'With --redeliver: maximum number of records to redeliver in this run',
    })
    .parseSync();

  if (argv.redeliver && argv.ack) {
    throw new Error('use either --redeliver or --ack, not both');
  }

  if (argv.redeliver) {
    const report = redeliverUndeliveredOpsAlerts({
      ...(typeof argv.limit === 'number' ? { limit: argv.limit } : {}),
    });
    if (json) {
      print(report);
    } else {
      print(
        [
          `Redelivery: attempted=${report.attempted} delivered=${report.delivered} failed=${report.failed}`,
          ...report.outcomes
            .filter((entry) => !entry.delivered)
            .map((outcome) => `  failed: ${outcome.ref} (${outcome.title}): ${outcome.error}`),
          `Receipts appended to ${report.recorded_path}`,
        ].join('\n')
      );
    }
    return;
  }

  if (argv.ack) {
    const receipt = acknowledgeOpsAlerts({
      ...(argv.before ? { before: argv.before } : {}),
    });
    if (json) {
      print(receipt);
    } else {
      print(
        [
          `Acknowledged ${receipt.acked_count} undelivered record(s) with timestamp <= ${receipt.before}`,
          `Ack record appended to ${receipt.recorded_path}`,
        ].join('\n')
      );
    }
    return;
  }

  const summary = summarizeOpsAlertLog(readOpsAlertLogRecords());
  if (summary.undelivered.outstanding > 0) {
    enqueueOperationalLearningSignal({
      signalId: 'undelivered-ops-alerts',
      sourceType: 'routine_exception',
      sourceRef: `ops-alert:undelivered:${nowIso().slice(0, 10)}`,
      title: 'Operator notifications remain undelivered',
      summary:
        'The ops-alert backlog contains notifications that were not delivered. Configure a channel or explicitly acknowledge the backlog, then decide whether the delivery policy needs a permanent runbook update.',
      evidenceRefs: [`ops-alert-log:outstanding:${summary.undelivered.outstanding}`],
      metadata: {
        outstanding: summary.undelivered.outstanding,
        by_reason: summary.undelivered.by_reason,
        by_event: summary.undelivered.by_event,
      },
    });
  }
  if (json) {
    print(summary);
    return;
  }
  print(formatOpsAlertSummary(summary).join('\n'));
}

export const runOpsAlerts = defineScript({
  name: 'ops:alerts',
  flags: ['json', 'quiet'],
  run: ({ argv, print, json }) => main(argv, print, json),
});

if (
  isDirectScript(import.meta.url, 'ops_alerts.ts') ||
  isDirectScript(import.meta.url, 'ops_alerts.js')
) {
  void runOpsAlerts();
}
