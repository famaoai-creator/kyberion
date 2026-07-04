#!/usr/bin/env node
import {
  listDaemonHeartbeatStatuses,
  readDaemonHeartbeat,
  type DaemonHeartbeatStatus,
} from '@agent/core';
import { sendOpsAlert, type OpsAlertReceipt } from '@agent/core';
import { createStandardYargs } from '@agent/core';

const DEFAULT_DAEMONS = ['chronos-daemon', 'agent-runtime-supervisor-daemon'];
const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

export interface DaemonWatchdogReport {
  ok: boolean;
  timestamp: string;
  statuses: DaemonHeartbeatStatus[];
  alert?: OpsAlertReceipt;
}

export interface DaemonWatchdogOptions {
  daemons?: string[];
  rootDir?: string;
  now?: Date;
  staleAfterMs?: number;
  alertLogPath?: string;
  webhookUrl?: string;
}

function parseDaemons(value: unknown): string[] {
  if (value === undefined || value === null) return DEFAULT_DAEMONS;
  const values = Array.isArray(value) ? value : [value];
  const parsed = values
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_DAEMONS;
}

function formatAge(status: DaemonHeartbeatStatus): string {
  if (status.age_ms === undefined) return 'n/a';
  return `${Math.round(status.age_ms / 1000)}s`;
}

export function checkDaemonHeartbeats(options: DaemonWatchdogOptions = {}): DaemonWatchdogReport {
  const now = options.now ?? new Date();
  const daemons = options.daemons ?? DEFAULT_DAEMONS;
  const heartbeatOptions = {
    rootDir: options.rootDir,
    now,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };
  const statuses =
    daemons.length > 0
      ? daemons.map((daemonId) => readDaemonHeartbeat(daemonId, heartbeatOptions))
      : listDaemonHeartbeatStatuses(heartbeatOptions);
  const failed = statuses.filter((status) => status.status !== 'healthy');
  const report: DaemonWatchdogReport = {
    ok: failed.length === 0,
    timestamp: now.toISOString(),
    statuses,
  };
  if (failed.length > 0) {
    report.alert = sendOpsAlert(
      {
        severity: 'critical',
        title: 'Daemon heartbeat watchdog detected unhealthy daemon(s)',
        context: {
          unhealthy_count: failed.length,
          unhealthy_daemons: failed.map((status) => ({
            daemon_id: status.daemon_id,
            status: status.status,
            age_ms: status.age_ms,
            reason: status.reason,
          })),
          stale_after_ms: heartbeatOptions.staleAfterMs,
        },
        recommendation:
          'Verify the launchd/systemd unit for each unhealthy daemon, restart the unit if needed, and inspect the daemon logs before resuming unattended operation.',
        options: [
          'macOS: launchctl kickstart -k gui/$UID/com.kyberion.<daemon>',
          'Linux: sudo systemctl restart kyberion-<daemon>',
          'Run pnpm daemon:watchdog -- --json after restart to confirm recovery',
        ],
        dedupe_key: `daemon-watchdog:${failed.map((status) => `${status.daemon_id}:${status.status}`).join(',')}`,
      },
      {
        now,
        alertLogPath: options.alertLogPath,
        webhookUrl: options.webhookUrl,
      }
    );
  }
  return report;
}

export function formatDaemonWatchdogReport(report: DaemonWatchdogReport): string[] {
  const lines = [
    `Daemon watchdog: ${report.ok ? 'ok' : 'failed'}; checked=${report.statuses.length}; timestamp=${report.timestamp}`,
  ];
  for (const status of report.statuses) {
    lines.push(
      `- ${status.daemon_id}: ${status.status}; age=${formatAge(status)}${
        status.reason ? `; reason=${status.reason}` : ''
      }`
    );
  }
  if (report.alert) {
    lines.push(
      `Ops alert: recorded=${report.alert.recorded_path}; suppressed=${report.alert.suppressed}; webhook=${report.alert.webhook_delivered ? 'delivered' : 'not-delivered'}`
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .option('daemon', {
      type: 'array',
      describe: 'Daemon id(s) to check. Repeatable or comma-separated.',
    })
    .option('root-dir', { type: 'string', describe: 'Heartbeat directory override' })
    .option('stale-after-ms', {
      type: 'number',
      default: DEFAULT_STALE_AFTER_MS,
      describe: 'Heartbeat age threshold before a daemon is stale',
    })
    .parseSync();

  const report = checkDaemonHeartbeats({
    daemons: parseDaemons(argv.daemon),
    rootDir: argv.rootDir,
    staleAfterMs: argv.staleAfterMs,
  });
  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatDaemonWatchdogReport(report)) console.log(line);
  }
  process.exit(report.ok ? 0 : 1);
}

const isDirect = process.argv[1] && /daemon_watchdog\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
