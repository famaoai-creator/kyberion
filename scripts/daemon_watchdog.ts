#!/usr/bin/env node
import {
  listDaemonHeartbeatStatuses,
  readDaemonHeartbeat,
  type DaemonHeartbeatStatus,
} from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';
import { sendOpsAlert, type OpsAlertReceipt } from '@agent/core';
import { createStandardYargs } from '@agent/core';
import {
  createTriggerRunner,
  runWakeTrigger,
  evaluateAutonomousOpsAction,
  withExecutionContextAsync,
  type AutonomousOpsGateResult,
  type TriggerReceipt,
} from '@agent/core';

/**
 * EV-05: every long-lived daemon that fires work must be listed here.
 *
 * `generation-schedule-daemon` was absent and recorded no heartbeat at all, so
 * an outage was invisible — and because the generation scheduler had no
 * catch-up (EV-01), every firing during that outage was lost for good rather
 * than merely late. check_event_wiring now fails if a daemon records a
 * heartbeat without appearing in this list.
 */
export const DEFAULT_DAEMONS = [
  'chronos-daemon',
  'agent-runtime-supervisor-daemon',
  'generation-schedule-daemon',
];
const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

export interface DaemonWatchdogReport {
  ok: boolean;
  timestamp: string;
  statuses: DaemonHeartbeatStatus[];
  alert?: OpsAlertReceipt;
  /** EV-02: one governed recovery receipt per unhealthy daemon. */
  recovery?: DaemonRecoveryOutcome[];
}

export interface DaemonRecoveryOutcome {
  daemon_id: string;
  /** autonomous-ops-gate verdict for the `daemon_restart` action. */
  decision: 'auto' | 'notify' | 'approve';
  trigger_status: TriggerReceipt['status'];
  requires_operator: boolean;
  reason?: string;
}

/** EV-02: the watchdog's own authority; see authority-roles/daemon_watchdog.json. */
export const DAEMON_WATCHDOG_ROLE = 'daemon_watchdog';

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

/**
 * EV-02: heartbeat check plus a governed recovery request per unhealthy daemon.
 *
 * `checkDaemonHeartbeats` stays synchronous and side-effect-light so existing
 * callers and tests keep working; recovery needs the trigger gate, which is
 * async by contract (it takes a store lock).
 */
export async function checkDaemonHeartbeatsWithRecovery(
  options: DaemonWatchdogOptions & { triggerStorePath?: string } = {}
): Promise<DaemonWatchdogReport> {
  const now = options.now ?? new Date();
  const report = checkDaemonHeartbeats({ ...options, now });
  const unhealthy = report.statuses.filter((status) => status.status !== 'healthy');
  if (unhealthy.length === 0) return report;
  try {
    return {
      ...report,
      recovery: await requestDaemonRecovery(unhealthy, now, {
        ...(options.triggerStorePath ? { triggerStorePath: options.triggerStorePath } : {}),
      }),
    };
  } catch (error) {
    // A recovery path that throws must not hide the outage it was reporting.
    return {
      ...report,
      recovery: unhealthy.map((status) => ({
        daemon_id: status.daemon_id,
        decision: 'approve' as const,
        trigger_status: 'failed' as const,
        requires_operator: true,
        reason: `recovery request failed: ${error instanceof Error ? error.message : String(error)}`,
      })),
    };
  }
}

/**
 * EV-02: turn "a daemon is unhealthy" into a governed recovery request.
 *
 * The watchdog previously ended at an ops alert whose recommendation was a
 * shell command for a human to run — so an outage produced advice, never a
 * tracked recovery attempt. Each unhealthy daemon now raises one `wake` trigger
 * (idempotent per daemon-and-status-minute, authority-checked, audited) whose
 * delivery consults `autonomous-ops-gate`.
 *
 * `daemon_restart` is deliberately scored to land on `approve`: the restart is a
 * platform service-manager command outside the repo sandbox, and restarting a
 * scheduler mid-firing can duplicate or drop work. So this records a governed,
 * attributable request and tells the operator what is waiting — it does not
 * shell out. When the gate says `auto` (a policy the operator can choose), the
 * receipt says so and an executor can act on it.
 */
export async function requestDaemonRecovery(
  unhealthy: DaemonHeartbeatStatus[],
  now: Date,
  options: { triggerStorePath?: string } = {}
): Promise<DaemonRecoveryOutcome[]> {
  if (unhealthy.length === 0) return [];
  // Tests point the receipt store at a temp path so they never write to the
  // real trigger-deliveries ledger.
  const runner = createTriggerRunner(
    options.triggerStorePath ? { storePath: options.triggerStorePath } : {}
  );
  const minuteKey = now.toISOString().slice(0, 16);

  return withExecutionContextAsync(DAEMON_WATCHDOG_ROLE, async () => {
    const outcomes: DaemonRecoveryOutcome[] = [];
    for (const status of unhealthy) {
      // Captured by the delivery callback below. Held as the whole gate result
      // so the verdict and its reason cannot drift apart.
      let gate: AutonomousOpsGateResult | null = null;
      const receipt = await runWakeTrigger(
        runner,
        {
          // Status is part of the key: a daemon going stale and later missing
          // are two distinct recoveries, not a duplicate of one.
          idempotencyKey: `daemon-recovery:${status.daemon_id}:${status.status}:${minuteKey}`,
          createdBy: { authority_role: DAEMON_WATCHDOG_ROLE, level: 40 },
          payload: {
            daemon_id: status.daemon_id,
            daemon_status: status.status,
            age_ms: status.age_ms,
            detected_at: now.toISOString(),
          },
        },
        () => {
          gate = evaluateAutonomousOpsAction({ actionId: 'daemon_restart' });
          return `daemon-recovery:${status.daemon_id}:${gate.decision}`;
        }
      );

      // A duplicate/rejected receipt means the callback never ran, so there is
      // no verdict — fall back to the safe end of the scale rather than
      // reporting an auto-eligible recovery that was never evaluated.
      const evaluated: AutonomousOpsGateResult | null = gate;
      const reason = receipt.reason ?? evaluated?.reason;
      outcomes.push({
        daemon_id: status.daemon_id,
        decision: evaluated?.decision ?? 'approve',
        trigger_status: receipt.status,
        // Anything short of `auto` needs a human before the daemon comes back.
        requires_operator: evaluated?.decision !== 'auto',
        ...(reason ? { reason } : {}),
      });
    }
    return outcomes;
  });
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
  for (const recovery of report.recovery ?? []) {
    lines.push(
      `Recovery ${recovery.daemon_id}: gate=${recovery.decision}; trigger=${recovery.trigger_status}; ${
        recovery.requires_operator ? 'awaiting operator' : 'auto-eligible'
      }${recovery.reason ? `; reason=${recovery.reason}` : ''}`
    );
  }
  return lines;
}

async function main(args: string[] = []): Promise<number> {
  const argv = await createStandardYargs(['node', 'daemon_watchdog', ...args])
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

  const report = await checkDaemonHeartbeatsWithRecovery({
    daemons: parseDaemons(argv.daemon),
    rootDir: argv.rootDir,
    staleAfterMs: argv.staleAfterMs,
  });
  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatDaemonWatchdogReport(report)) console.log(line);
  }
  return report.ok ? 0 : 1;
}

if (
  isDirectScript(import.meta.url, 'daemon_watchdog.ts') ||
  isDirectScript(import.meta.url, 'daemon_watchdog.js')
) {
  void defineScript({
    name: 'daemon:watchdog',
    flags: [],
    async run(context) {
      const status = await main(context.argv);
      if (status !== 0) throw new Error(`daemon:watchdog failed with exit code ${status}`);
    },
  })();
}
