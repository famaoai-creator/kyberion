import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { recordDaemonHeartbeat, readDaemonHeartbeat } from '../daemon-heartbeat.js';
import {
  registerScheduledPipeline,
  loadScheduleRegistry,
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
  type ScheduledPipeline,
} from '../pipeline/pipeline-scheduler.js';

const fixture = pathResolver.sharedTmp(`scheduler-instance-runtime-${process.pid}-${randomUUID()}`);
const now = new Date('2026-10-26T00:00:00Z');
beforeEach(() => vi.stubEnv('KYBERION_CHRONOS_SCHEDULES', ''));
afterEach(() => {
  safeRmSync(fixture, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('coexisting scheduler runtime stores', () => {
  it('keeps identical schedule ids, claims, completion and heartbeats independent across checkout roots', () => {
    const roots = ['prod', 'development'].map((name) => path.join(fixture, name));
    const schedule: ScheduledPipeline = {
      id: 'shared-pipeline-id',
      name: 'Instance-local fixture',
      pipelinePath: 'pipelines/fixture.json',
      actuator: 'system',
      trigger: { type: 'cron', cron: '* * * * *', timezone: 'UTC' },
      enabled: true,
    };
    for (const rootDir of roots) {
      safeMkdir(path.join(rootDir, 'pipelines'), { recursive: true });
      safeWriteFile(path.join(rootDir, schedule.pipelinePath), '{}');
      registerScheduledPipeline(schedule, { rootDir, now });
    }
    const a = claimScheduledPipelineRun(schedule.id, { rootDir: roots[0], now });
    const b = claimScheduledPipelineRun(schedule.id, { rootDir: roots[1], now });
    expect(a?.runLock?.token).toBeTruthy();
    expect(b?.runLock?.token).toBeTruthy();
    expect(a!.runLock!.token).not.toBe(b!.runLock!.token);
    expect(claimScheduledPipelineRun(schedule.id, { rootDir: roots[0], now })).toBeNull();
    expect(
      completeScheduledPipelineRun(schedule.id, b!.runLock!.token, 'succeeded', {
        rootDir: roots[0],
        now,
      })
    ).toBeNull();
    completeScheduledPipelineRun(schedule.id, a!.runLock!.token, 'succeeded', {
      rootDir: roots[0],
      now,
    });
    expect(loadScheduleRegistry({ rootDir: roots[0] }).schedules[0]?.lastStatus).toBe('succeeded');
    expect(loadScheduleRegistry({ rootDir: roots[1] }).schedules[0]?.runLock?.token).toBe(
      b!.runLock!.token
    );

    const heartbeatRoots = roots.map((root) => path.join(root, 'active/shared/runtime/heartbeats'));
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 111, status: 'running' },
      { rootDir: heartbeatRoots[0], now }
    );
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 222, status: 'running' },
      { rootDir: heartbeatRoots[1], now }
    );
    recordDaemonHeartbeat(
      'chronos-daemon',
      { pid: 111, status: 'stopping' },
      { rootDir: heartbeatRoots[0], now }
    );
    expect(
      readDaemonHeartbeat('chronos-daemon', { rootDir: heartbeatRoots[1], now })
    ).toMatchObject({
      status: 'healthy',
      heartbeat: { pid: 222, status: 'running' },
    });
  });
});
