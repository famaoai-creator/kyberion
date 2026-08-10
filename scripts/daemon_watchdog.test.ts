import { describe, expect, it } from 'vitest';
import {
  checkDaemonHeartbeats,
  checkDaemonHeartbeatsWithRecovery,
  formatDaemonWatchdogReport,
  DEFAULT_DAEMONS,
} from './daemon_watchdog.js';
import {
  recordDaemonHeartbeat,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
} from '@agent/core';

const ROOT = pathResolver.sharedTmp('daemon-watchdog-test/heartbeats');
const ALERT_LOG = pathResolver.sharedTmp('daemon-watchdog-test/alerts.jsonl');
const TRIGGER_STORE = 'active/shared/tmp/daemon-watchdog-test/trigger-deliveries.jsonl';

describe('daemon_watchdog', () => {
  it('passes when configured daemons have fresh heartbeats', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const now = new Date('2026-07-04T00:00:00.000Z');
    // EV-05: derived from DEFAULT_DAEMONS rather than a hardcoded pair, so
    // adding a daemon to the watch list cannot silently rot this test.
    DEFAULT_DAEMONS.forEach((daemonId, index) => {
      recordDaemonHeartbeat(
        daemonId,
        { pid: 100 + index, status: 'running' },
        { rootDir: ROOT, now }
      );
    });

    const report = checkDaemonHeartbeats({
      rootDir: ROOT,
      now: new Date('2026-07-04T00:01:00.000Z'),
      alertLogPath: ALERT_LOG,
    });

    expect(report.ok).toBe(true);
    expect(report.alert).toBeUndefined();
    expect(report.statuses.map((status) => status.status)).toEqual(
      DEFAULT_DAEMONS.map(() => 'healthy')
    );
  });

  it('watches the generation schedule daemon (EV-05)', () => {
    // It recorded no heartbeat and was absent from the watch list, so its
    // outages produced no signal at all — and with no cron catch-up at the time,
    // every firing during the outage was lost rather than late.
    expect(DEFAULT_DAEMONS).toContain('generation-schedule-daemon');
  });

  it('raises a governed recovery request per unhealthy daemon (EV-02)', async () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const report = await checkDaemonHeartbeatsWithRecovery({
      daemons: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
      rootDir: ROOT,
      now: new Date('2026-07-04T00:10:00.000Z'),
      staleAfterMs: 3 * 60 * 1000,
      alertLogPath: ALERT_LOG,
      webhookUrl: '',
      triggerStorePath: TRIGGER_STORE,
    });

    expect(report.ok).toBe(false);
    expect(report.recovery).toHaveLength(2);
    for (const recovery of report.recovery ?? []) {
      // daemon_restart is scored to land on `approve`: the restart is a platform
      // service-manager command outside the sandbox, and restarting a scheduler
      // mid-firing can duplicate or drop work.
      expect(recovery.decision).toBe('approve');
      expect(recovery.requires_operator).toBe(true);
    }
    expect(formatDaemonWatchdogReport(report).join('\n')).toContain('awaiting operator');
  });

  it('records an ops alert when any heartbeat is stale or missing', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const report = checkDaemonHeartbeats({
      daemons: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
      rootDir: ROOT,
      now: new Date('2026-07-04T00:10:00.000Z'),
      staleAfterMs: 3 * 60 * 1000,
      alertLogPath: ALERT_LOG,
      webhookUrl: '',
    });

    expect(report.ok).toBe(false);
    expect(report.statuses.map((status) => status.status)).toEqual(['stale', 'missing']);
    expect(report.alert?.recorded_path).toBe(ALERT_LOG);
    expect(safeExistsSync(ALERT_LOG)).toBe(true);
    const line = String(safeReadFile(ALERT_LOG, { encoding: 'utf8' }))
      .trim()
      .split('\n')[0]!;
    expect(JSON.parse(line)).toMatchObject({
      severity: 'critical',
      title: 'Daemon heartbeat watchdog detected unhealthy daemon(s)',
    });
    expect(formatDaemonWatchdogReport(report).join('\n')).toContain('Ops alert: recorded=');
  });
});
