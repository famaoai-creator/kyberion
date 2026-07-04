import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { checkDaemonHeartbeats, formatDaemonWatchdogReport } from './daemon_watchdog.js';
import {
  recordDaemonHeartbeat,
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
} from '@agent/core';

const ROOT = pathResolver.sharedTmp('daemon-watchdog-test/heartbeats');
const ALERT_LOG = pathResolver.sharedTmp('daemon-watchdog-test/alerts.jsonl');

describe('daemon_watchdog', () => {
  it('passes when configured daemons have fresh heartbeats', () => {
    safeRmSync(pathResolver.sharedTmp('daemon-watchdog-test'), { recursive: true, force: true });
    const now = new Date('2026-07-04T00:00:00.000Z');
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 101, status: 'running' },
      { rootDir: ROOT, now }
    );
    recordDaemonHeartbeat(
      'agent-runtime-supervisor-daemon',
      { pid: 102, status: 'running' },
      { rootDir: ROOT, now }
    );

    const report = checkDaemonHeartbeats({
      rootDir: ROOT,
      now: new Date('2026-07-04T00:01:00.000Z'),
      alertLogPath: ALERT_LOG,
    });

    expect(report.ok).toBe(true);
    expect(report.alert).toBeUndefined();
    expect(report.statuses.map((status) => status.status)).toEqual(['healthy', 'healthy']);
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
    const line = String(safeReadFile(ALERT_LOG, { encoding: 'utf8' })).trim();
    expect(JSON.parse(line)).toMatchObject({
      severity: 'critical',
      title: 'Daemon heartbeat watchdog detected unhealthy daemon(s)',
    });
    expect(formatDaemonWatchdogReport(report).join('\n')).toContain('Ops alert: recorded=');
  });
});
