import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  loadDaemonHeartbeatAtPath,
  listDaemonHeartbeatStatuses,
  readDaemonHeartbeat,
  recordDaemonHeartbeat,
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
