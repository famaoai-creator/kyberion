import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  loadDaemonHeartbeatAtPath,
  listDaemonHeartbeatStatuses,
  readDaemonHeartbeat,
  recordDaemonHeartbeat,
  DAEMON_TICK_IN_PROGRESS_MAX_MS,
  tickInProgressAgeMs,
} from './daemon-heartbeat.js';
import { pathResolver } from './index.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const HEARTBEAT_TEST_ROOT = pathResolver.sharedTmp('daemon-heartbeat-test');

describe('daemon-heartbeat', () => {
  it('rejects a heartbeat root outside the repository', () => {
    expect(() =>
      readDaemonHeartbeat('chronos-daemon', { rootDir: '../outside-heartbeats' })
    ).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('records and reads a healthy daemon heartbeat', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 123, status: 'running', details: { phase: 'tick' } },
      { rootDir: HEARTBEAT_TEST_ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const status = readDaemonHeartbeat('chronos-daemon', {
      rootDir: HEARTBEAT_TEST_ROOT,
      now: new Date('2026-07-04T00:01:00.000Z'),
      staleAfterMs: 180_000,
    });

    expect(status.status).toBe('healthy');
    expect(status.heartbeat?.pid).toBe(123);
    expect(status.heartbeat?.details).toEqual({ phase: 'tick' });
  });

  it('treats a fresh in-progress heartbeat as alive until the tick overruns its limit', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    const read = (heartbeatAt: string, nowAt: string) => {
      recordDaemonHeartbeat(
        'chronos-daemon',
        {
          pid: 123,
          status: 'running',
          details: { phase: 'tick_in_progress', tick_started_at: '2026-07-04T00:00:00.000Z' },
        },
        { rootDir: HEARTBEAT_TEST_ROOT, now: new Date(heartbeatAt) }
      );
      return readDaemonHeartbeat('chronos-daemon', {
        rootDir: HEARTBEAT_TEST_ROOT,
        now: new Date(nowAt),
        staleAfterMs: 180_000,
      });
    };
    // A 3-hour backup tick refreshing every minute is healthy.
    expect(read('2026-07-04T03:00:00.000Z', '2026-07-04T03:00:30.000Z').status).toBe('healthy');
    const overrun = read('2026-07-04T08:30:00.000Z', '2026-07-04T08:30:30.000Z');
    expect(DAEMON_TICK_IN_PROGRESS_MAX_MS).toBeLessThan(8.5 * 60 * 60 * 1000);
    expect(overrun.status).toBe('stale');
    expect(overrun.reason).toMatch(/tick in progress since 2026-07-04T00:00:00.000Z/);
    expect(tickInProgressAgeMs(overrun.heartbeat, Date.parse('2026-07-04T08:30:30.000Z'))).toBe(
      8.5 * 60 * 60 * 1000 + 30_000
    );
    expect(tickInProgressAgeMs({ details: { phase: 'tick' } }, Date.now())).toBeNull();
  });

  it('classifies stale and missing heartbeat files', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    recordDaemonHeartbeat(
      'agent-runtime-supervisor-daemon',
      { pid: 456, status: 'running' },
      { rootDir: HEARTBEAT_TEST_ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    expect(
      readDaemonHeartbeat('agent-runtime-supervisor-daemon', {
        rootDir: HEARTBEAT_TEST_ROOT,
        now: new Date('2026-07-04T00:04:00.000Z'),
        staleAfterMs: 180_000,
      }).status
    ).toBe('stale');
    expect(readDaemonHeartbeat('missing-daemon', { rootDir: HEARTBEAT_TEST_ROOT }).status).toBe(
      'missing'
    );
    expect(listDaemonHeartbeatStatuses({ rootDir: HEARTBEAT_TEST_ROOT })).toHaveLength(1);
  });

  it('flags a fresh heartbeat as stale when the daemon reports stale_code', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    recordDaemonHeartbeat(
      'agent-runtime-supervisor-daemon',
      {
        pid: 789,
        status: 'running',
        details: { stale_code: true, code_stamp: 1, dist_stamp: 2 },
      },
      { rootDir: HEARTBEAT_TEST_ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );

    const status = readDaemonHeartbeat('agent-runtime-supervisor-daemon', {
      rootDir: HEARTBEAT_TEST_ROOT,
      now: new Date('2026-07-04T00:00:30.000Z'),
      staleAfterMs: 180_000,
    });
    expect(status.status).toBe('stale');
    expect(status.reason).toContain('stale_code');
  });

  it('uses the strict schema and daemon binding for persisted heartbeats', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 123, status: 'running' },
      { rootDir: HEARTBEAT_TEST_ROOT, now: new Date('2026-07-04T00:00:00.000Z') }
    );
    const heartbeatPath = path.join(HEARTBEAT_TEST_ROOT, 'chronos-daemon.json');
    safeWriteFile(
      heartbeatPath,
      JSON.stringify({
        daemon_id: 'other-daemon',
        pid: 123,
        status: 'unknown',
        timestamp: '2026-07-04T00:00:00.000Z',
        unexpected: true,
      })
    );

    expect(() => loadDaemonHeartbeatAtPath(heartbeatPath, 'chronos-daemon')).toThrow(
      'Invalid catalog daemon-heartbeat'
    );
    expect(readDaemonHeartbeat('chronos-daemon', { rootDir: HEARTBEAT_TEST_ROOT }).status).toBe(
      'malformed'
    );
  });

  it('rejects a directory at a heartbeat path', () => {
    safeRmSync(HEARTBEAT_TEST_ROOT, { recursive: true, force: true });
    safeMkdir(HEARTBEAT_TEST_ROOT, { recursive: true });
    const heartbeatPath = path.join(HEARTBEAT_TEST_ROOT, 'chronos-daemon.json');
    safeMkdir(heartbeatPath, { recursive: true });

    expect(() => loadDaemonHeartbeatAtPath(heartbeatPath, 'chronos-daemon')).toThrow(
      'heartbeat must be a regular file'
    );
    expect(readDaemonHeartbeat('chronos-daemon', { rootDir: HEARTBEAT_TEST_ROOT }).status).toBe(
      'malformed'
    );
  });
});
