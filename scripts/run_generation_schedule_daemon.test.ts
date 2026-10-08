import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  resolveTickDeadlineMs,
  runTickAndReport,
  type TickReportDeps,
} from './run_generation_schedule_daemon.js';

describe('run_generation_schedule_daemon', () => {
  it('delegates fatal exit handling to the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_generation_schedule_daemon.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.exitCode =');
    expect(source).toContain('throw new ScriptExitError(1, message)');
    expect(source).toContain('recordDaemonHeartbeat(DAEMON_ID');
    expect(source).toContain('sendOpsAlert({');
  });
});

describe('resolveTickDeadlineMs (G10)', () => {
  it('defaults to max(5 x interval, 15 min)', () => {
    expect(resolveTickDeadlineMs(60_000, undefined)).toBe(15 * 60_000);
    expect(resolveTickDeadlineMs(10 * 60_000, undefined)).toBe(50 * 60_000);
  });

  it('honours a positive KYBERION_GENERATION_SCHEDULE_TICK_TIMEOUT_MS override only', () => {
    expect(resolveTickDeadlineMs(60_000, '120000')).toBe(120_000);
    expect(resolveTickDeadlineMs(60_000, '0')).toBe(15 * 60_000);
    expect(resolveTickDeadlineMs(60_000, 'soon')).toBe(15 * 60_000);
  });

  it('wires the deadline, signal forwarding and the serial loop into the daemon', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_generation_schedule_daemon.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('while (true)');
    expect(source).toContain('awaitChildWithDeadline(child');
    expect(source).toContain('currentChild?.kill(signal)');
    expect(source).toContain('`${DAEMON_ID}:tick-timeout`');
  });
});

describe('runTickAndReport (G10 review)', () => {
  function deps(shuttingDown: boolean) {
    return {
      runTick: vi.fn(async () => {
        throw new Error(
          'generation schedule daemon tick failed with exit code null (signal SIGTERM)'
        );
      }),
      isShuttingDown: () => shuttingDown,
      recordHeartbeat: vi.fn<TickReportDeps['recordHeartbeat']>(),
      sendAlert: vi.fn<TickReportDeps['sendAlert']>(),
    };
  }

  it('treats a child killed by the shutdown signal as a cancellation: no error heartbeat, no alert', async () => {
    const d = deps(true);
    await runTickAndReport(d);
    expect(d.sendAlert).not.toHaveBeenCalled();
    expect(d.recordHeartbeat).toHaveBeenCalledTimes(1);
    expect(d.recordHeartbeat.mock.calls[0][1]).toMatchObject({ status: 'running' });
  });

  it('still records an error heartbeat and alerts for a failure outside shutdown', async () => {
    const d = deps(false);
    await runTickAndReport(d);
    expect(d.recordHeartbeat.mock.calls.map((c) => c[1]?.status)).toEqual(['running', 'error']);
    expect(d.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: 'generation-schedule-daemon:tick-failed' })
    );
  });
});
