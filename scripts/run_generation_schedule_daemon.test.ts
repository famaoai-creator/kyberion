import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { resolveTickDeadlineMs } from './run_generation_schedule_daemon.js';

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
