import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
  getSchedulesDueNow,
  isScheduledPipelineDue,
  loadScheduleRegistry,
  registerScheduledPipeline,
} from './pipeline-scheduler.js';

describe('pipeline scheduler', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const rootDir = tempRoots.pop();
      if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  function makeRootDir(): string {
    const rootDir = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'pipeline-scheduler-'));
    tempRoots.push(rootDir);
    return rootDir;
  }

  it('treats cron schedules as due on the matching minute and during catch-up', () => {
    const schedule = {
      id: 'daily-routine',
      name: 'Daily routine',
      pipelinePath: '/tmp/daily-routine.json',
      actuator: 'run_pipeline',
      enabled: true,
      trigger: {
        type: 'cron' as const,
        cron: '0 6 * * *',
        timezone: 'Asia/Tokyo',
      },
    };

    expect(isScheduledPipelineDue(schedule, undefined, new Date('2026-07-05T06:00:00+09:00'))).toBe(
      true
    );
    expect(
      isScheduledPipelineDue(
        {
          ...schedule,
          lastRun: '2026-07-05T06:00:15+09:00',
        },
        undefined,
        new Date('2026-07-05T06:00:30+09:00')
      )
    ).toBe(false);
    expect(
      isScheduledPipelineDue(
        {
          ...schedule,
          lastRun: '2026-07-04T05:50:00+09:00',
        },
        undefined,
        new Date('2026-07-05T06:05:00+09:00')
      )
    ).toBe(true);
  });

  it('claims a schedule once, releases it, and allows the next run after completion', () => {
    const rootDir = makeRootDir();
    const now = new Date('2026-07-05T06:00:00+09:00');

    registerScheduledPipeline(
      {
        id: 'hourly-health',
        name: 'Hourly health check',
        pipelinePath: '/tmp/hourly-health.json',
        actuator: 'run_pipeline',
        enabled: true,
        trigger: {
          type: 'interval',
          intervalMs: 60_000,
        },
      },
      { rootDir, now }
    );

    const claimed = claimScheduledPipelineRun('hourly-health', { rootDir, now });
    expect(claimed?.runLock?.token).toBeTruthy();
    expect(loadScheduleRegistry({ rootDir }).schedules[0]?.runLock?.token).toBe(
      claimed?.runLock?.token
    );

    expect(
      claimScheduledPipelineRun('hourly-health', {
        rootDir,
        now: new Date('2026-07-05T06:00:30+09:00'),
      })
    ).toBeNull();

    expect(
      completeScheduledPipelineRun('hourly-health', claimed?.runLock?.token || '', 'succeeded', {
        rootDir,
        now: new Date('2026-07-05T06:00:35+09:00'),
      })
    ).not.toBeNull();

    const nextClaim = claimScheduledPipelineRun('hourly-health', {
      rootDir,
      now: new Date('2026-07-05T06:01:10+09:00'),
    });
    expect(nextClaim?.runLock?.token).toBeTruthy();
    expect(loadScheduleRegistry({ rootDir }).schedules[0]?.lastStatus).toBe('succeeded');
  });

  it('lists due schedules while excluding locked runs', () => {
    const rootDir = makeRootDir();
    const now = new Date('2026-07-05T06:00:00+09:00');

    registerScheduledPipeline(
      {
        id: 'daily-routine',
        name: 'Daily routine',
        pipelinePath: '/tmp/daily-routine.json',
        actuator: 'run_pipeline',
        enabled: true,
        trigger: {
          type: 'cron',
          cron: '0 6 * * *',
          timezone: 'Asia/Tokyo',
        },
      },
      { rootDir, now }
    );

    expect(getSchedulesDueNow(undefined, now, { rootDir })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'daily-routine' })])
    );

    claimScheduledPipelineRun('daily-routine', { rootDir, now });
    expect(loadScheduleRegistry({ rootDir }).schedules[0]?.runLock?.token).toBeTruthy();
    expect(getSchedulesDueNow(undefined, now, { rootDir })).toEqual([]);
  });

  it('preserves runtime state when a schedule is re-registered', () => {
    const rootDir = makeRootDir();
    const now = new Date('2026-07-05T06:00:00+09:00');

    registerScheduledPipeline(
      {
        id: 'daily-routine',
        name: 'Daily routine',
        pipelinePath: '/tmp/daily-routine.json',
        actuator: 'run_pipeline',
        enabled: true,
        trigger: {
          type: 'cron',
          cron: '0 6 * * *',
          timezone: 'Asia/Tokyo',
        },
      },
      { rootDir, now }
    );

    const claimed = claimScheduledPipelineRun('daily-routine', { rootDir, now });
    expect(claimed?.runLock?.token).toBeTruthy();

    registerScheduledPipeline(
      {
        id: 'daily-routine',
        name: 'Daily routine (updated)',
        pipelinePath: '/tmp/daily-routine.json',
        actuator: 'run_pipeline',
        enabled: true,
        trigger: {
          type: 'cron',
          cron: '0 6 * * *',
          timezone: 'Asia/Tokyo',
        },
      },
      { rootDir, now: new Date('2026-07-05T06:00:30+09:00') }
    );

    const registry = loadScheduleRegistry({ rootDir });
    expect(registry.schedules[0]?.name).toBe('Daily routine (updated)');
    expect(registry.schedules[0]?.lastRun).toBe(claimed?.runLock?.acquiredAt);
    expect(registry.schedules[0]?.runLock?.token).toBe(claimed?.runLock?.token);
  });
});
