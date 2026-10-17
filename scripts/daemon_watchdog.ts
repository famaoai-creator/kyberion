#!/usr/bin/env node
import {
  listDaemonHeartbeatStatuses,
  readDaemonHeartbeat,
  type DaemonHeartbeatStatus,
} from '@agent/core/daemon-heartbeat';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { sendOpsAlert, type OpsAlertReceipt } from '@agent/core/ops-alert';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  createTriggerRunner,
  runWakeTrigger,
  type TriggerReceipt,
} from '@agent/core/trigger-runner';
import {
  evaluateAutonomousOpsAction,
  type AutonomousOpsGateResult,
} from '@agent/core/governance/autonomous-ops-gate';
import { withExecutionContextAsync } from '@agent/core/authority';
import {
  isAutonomyDecisionRoutingEnabled,
  routeAutonomousDecision,
} from '@agent/core/governance/approval-decision-routing';
import { listActiveDotHeartbeatSpecs, type DotHeartbeatSpec } from '@agent/core/dot/dot-runtime';
import { logger } from '@agent/core/core';
import { DAEMON_SPECS } from '@agent/core/daemon/specs';
import { resolveDaemonManager } from '@agent/core/daemon/service-manager';
import { safeExecResult } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  recordAutonomyOutcome,
  sweepAutonomyActionStates,
} from '@agent/core/governance/autonomy-action-state';
import * as nodePath from 'node:path';
import * as os from 'node:os';

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
  /**
   * HITL decision card raised for the operator (opt-in,
   * `KYBERION_AUTONOMY_DECISION_ROUTING=1`); reused while one is pending.
   */
  decision_request_id?: string;
  /** Gate said `auto` and policy allowed — restart plan was executed. */
  auto_executed?: boolean;
  auto_error?: string;
}

function routeDaemonRecoveryDecision(
  status: DaemonHeartbeatStatus,
  gate: AutonomousOpsGateResult
): string | undefined {
  try {
    const routed = routeAutonomousDecision({
      // A shared role libs/core stores assume on behalf of every caller; the
      // watchdog's own authority has no approval-store scope.
      role: 'infrastructure_sentinel',
      gate,
      title: `Restart daemon ${status.daemon_id}`,
      question: `Restart the ${status.daemon_id} daemon (heartbeat ${status.status})?`,
      recommendation: `Restart it after checking that no firing is in flight; the heartbeat is ${status.status}.`,
      requestedBy: DAEMON_WATCHDOG_ROLE,
      dedupeKey: status.daemon_id,
    });
    return routed.requestId;
  } catch (error) {
    // The recovery receipt already records the outage; a routing failure must
    // not hide it.
    logger.warn(
      `[daemon-watchdog] decision routing failed for ${status.daemon_id} — ${
        error instanceof Error ? error.message : String(error)
      } | next: decide from the watchdog report`
    );
    return undefined;
  }
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
  /**
   * Dot heartbeat specs to union into the supervised set (tests inject; the
   * default resolves live charters). Ignored when `daemons` is explicit.
   */
  dotHeartbeatSpecs?: DotHeartbeatSpec[];
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
  // Active dot charters join the supervised set so a silent dot pages like any
  // daemon; a paused/retired dot drops out automatically on the next run, and
  // a dot's staleness is its own max_idle_wake_ms (dots heartbeat per wake,
  // not per daemon tick). Charters always live at repo-root `dots/` —
  // options.rootDir only overrides the heartbeat directory, not charters.
  const dotSpecs = options.daemons
    ? []
    : (options.dotHeartbeatSpecs ?? listActiveDotHeartbeatSpecs());
  const dotStaleAfter = new Map(
    dotSpecs.map((spec) => [spec.heartbeat_id, spec.stale_after_ms] as const)
  );
  const daemons = options.daemons ?? [
    ...DEFAULT_DAEMONS,
    ...dotSpecs.map((spec) => spec.heartbeat_id).filter((id) => !DEFAULT_DAEMONS.includes(id)),
  ];
  const baseHeartbeatOptions = {
    rootDir: options.rootDir,
    now,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };
  const statuses =
    daemons.length > 0
      ? daemons.map((daemonId) =>
          readDaemonHeartbeat(daemonId, {
            ...baseHeartbeatOptions,
            staleAfterMs: dotStaleAfter.get(daemonId) ?? baseHeartbeatOptions.staleAfterMs,
          })
        )
      : listDaemonHeartbeatStatuses(baseHeartbeatOptions);
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
          stale_after_ms: baseHeartbeatOptions.staleAfterMs,
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
  // Evidence-driven autonomy sweep runs every watchdog pass — cheap (ledger
  // tail scan) and keeps promotion/demotion close to the signal source.
  try {
    sweepAutonomyActionStates(
      ['daemon_restart'],
      options.rootDir ? { rootDir: options.rootDir } : {}
    );
  } catch {
    /* sweep failures must never mask a watchdog verdict */
  }
  const unhealthy = report.statuses.filter((status) => status.status !== 'healthy');
  if (unhealthy.length === 0) return report;
  try {
    return {
      ...report,
      recovery: await requestDaemonRecovery(unhealthy, now, {
        ...(options.triggerStorePath ? { triggerStorePath: options.triggerStorePath } : {}),
        ...(options.rootDir ? { rootDir: options.rootDir } : {}),
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
 * `daemon_restart` is reclassified to land on `notify` (score 5): a service
 * restart is designed-reversible (the service manager re-binds the unit) and
 * touches no secrets — the remaining risk is scope. `notify` still requires
 * an operator, but it now sits on the evidence ladder: sustained clean
 * decisions promote it to `auto` via autonomy-action-state, at which point
 * the receipt says `auto_executed` and the service-manager plan runs.
 */
export async function requestDaemonRecovery(
  unhealthy: DaemonHeartbeatStatus[],
  now: Date,
  options: { triggerStorePath?: string; rootDir?: string } = {}
): Promise<DaemonRecoveryOutcome[]> {
  const recoveryRootDir = options.rootDir;
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
      // Anything short of `auto` needs a human before the daemon comes back.
      const requiresOperator = evaluated?.decision !== 'auto' || !evaluated.allowed;
      const decisionRequestId =
        evaluated && requiresOperator && isAutonomyDecisionRoutingEnabled()
          ? routeDaemonRecoveryDecision(status, evaluated)
          : undefined;
      // Gate said `auto` AND policy allowed: act on the governed receipt —
      // execute the service-manager restart plan through the governed exec
      // seam. This is stage 5 of the autonomous loop (was previously just
      // 'auto-eligible' with no executor).
      let autoExecuted: boolean | undefined;
      let autoExecError: string | undefined;
      if (!requiresOperator) {
        const spec = DAEMON_SPECS[status.daemon_id.replace(/-daemon$/, '')];
        const manager = resolveDaemonManager();
        if (spec?.id === 'daemon-watchdog') {
          // kickstart -k would SIGTERM this very run before it could relaunch;
          // a stale watchdog is an operator problem, not a self-heal target.
          autoExecuted = false;
          autoExecError = 'self-restart refused — watchdog cannot kickstart its own unit mid-run';
        } else if (spec && manager) {
          const plan = manager.planRestart(spec, {
            nodePath: process.execPath,
            repoRoot: pathResolver.rootDir(),
            homeDir: os.homedir(),
            uid: String(process.getuid?.() ?? 0),
            stagingDir: nodePath.join(pathResolver.sharedTmp(), 'daemon-staging'),
          });
          let ok = true;
          for (const cmd of plan.commands) {
            const r = safeExecResult(cmd.run[0]!, cmd.run.slice(1), { timeoutMs: 30_000 });
            if (r.status !== 0 && !cmd.tolerateFailure) {
              ok = false;
              autoExecError = `${cmd.describe ?? cmd.run.join(' ')}: exit ${r.status} ${String(r.stderr).slice(0, 200)}`;
              break;
            }
          }
          autoExecuted = ok;
          logger.info(
            `[daemon-watchdog] auto-restart ${status.daemon_id}: ${ok ? 'executed' : `failed — ${autoExecError}`}`
          );
        } else {
          autoExecuted = false;
          autoExecError = `no service spec for ${status.daemon_id} on ${process.platform}`;
        }
      }
      // Feed the evidence ledger — every gate decision is a data point for
      // action-level autonomy promotion (executed runs add the outcome).
      try {
        recordAutonomyOutcome(
          {
            action_id: 'daemon_restart',
            decision: evaluated?.decision ?? 'approve',
            executed: autoExecuted === true,
            ...(autoExecuted !== undefined ? { ok: autoExecuted } : {}),
            ...(autoExecError ? { error: autoExecError } : {}),
          },
          recoveryRootDir ? { rootDir: recoveryRootDir } : {}
        );
      } catch {
        /* ledger write failures must never mask a recovery verdict */
      }
      outcomes.push({
        daemon_id: status.daemon_id,
        decision: evaluated?.decision ?? 'approve',
        trigger_status: receipt.status,
        requires_operator: requiresOperator,
        ...(autoExecuted !== undefined
          ? { auto_executed: autoExecuted, ...(autoExecError ? { auto_error: autoExecError } : {}) }
          : {}),
        ...(reason ? { reason } : {}),
        ...(decisionRequestId ? { decision_request_id: decisionRequestId } : {}),
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
        recovery.requires_operator
          ? 'awaiting operator'
          : `auto${recovery.auto_executed === true ? ' executed' : recovery.auto_executed === false ? ` exec-failed (${recovery.auto_error ?? '?'})` : '-eligible'}`
      }${recovery.decision_request_id ? `; decision=${recovery.decision_request_id}` : ''}${
        recovery.reason ? `; reason=${recovery.reason}` : ''
      }`
    );
  }
  return lines;
}

async function main(args: string[] = []) {
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
    daemons: argv.daemon !== undefined ? parseDaemons(argv.daemon) : undefined,
    rootDir: argv.rootDir,
    staleAfterMs: argv.staleAfterMs,
  });
  return report;
}

if (
  isDirectScript(import.meta.url, 'daemon_watchdog.ts') ||
  isDirectScript(import.meta.url, 'daemon_watchdog.js')
) {
  void defineScript({
    name: 'daemon:watchdog',
    flags: ['json'],
    async run(context) {
      const report = await main(context.argv);
      context.print(context.json ? report : formatDaemonWatchdogReport(report).join('\n'));
      if (!report.ok) throw new ScriptExitError(1, '', true);
      return report;
    },
  })();
}
