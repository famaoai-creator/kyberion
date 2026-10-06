import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeReadFile as readRepoFile } from '../secure-io.js';
import {
  normalizeScheduledPipelinePath,
  resolveScheduledPipelinePath,
  type PipelineScheduleRegistry,
  type ScheduledPipeline,
  scheduleAllowedByOperator,
  scheduleExplicitlyOptedIn,
} from './pipeline-scheduler.js';
import { pathResolver } from '../path-resolver.js';
import { safeWriteFile } from '../secure-io.js';
import {
  claimScheduledPipelineRun,
  completeScheduledPipelineRun,
  getSchedulesDueNow,
  isScheduledPipelineDue,
  loadScheduleRegistry,
  reconcileScheduledPipelines,
  registerScheduledPipeline,
  saveScheduleRegistry,
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
      pipelinePath: 'pipelines/daily-routine.json',
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
        pipelinePath: 'pipelines/hourly-health.json',
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
        pipelinePath: 'pipelines/daily-routine.json',
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
        pipelinePath: 'pipelines/daily-routine.json',
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
        pipelinePath: 'pipelines/daily-routine.json',
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

  it('reconciles a managed source with one write and leaves no-op ticks untouched', () => {
    const rootDir = makeRootDir();
    const registryPath = path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json');
    const managed = {
      id: 'daily-managed',
      name: 'Daily managed',
      pipelinePath: 'pipelines/daily-managed.json',
      actuator: 'run_pipeline',
      trigger: { type: 'cron' as const, cron: '0 6 * * *' },
      enabled: true,
    };
    const manual = {
      id: 'manual-schedule',
      name: 'Manual schedule',
      pipelinePath: 'pipelines/manual.json',
      actuator: 'run_pipeline',
      trigger: { type: 'cron' as const, cron: '0 8 * * *' },
      enabled: true,
    };

    registerScheduledPipeline(manual, { rootDir });
    expect(reconcileScheduledPipelines('chronos_adf', [managed], { rootDir })).toMatchObject({
      added: 1,
      updated: 0,
      removed: 0,
    });
    const firstMtime = fs.statSync(registryPath, { bigint: true }).mtimeNs;

    expect(reconcileScheduledPipelines('chronos_adf', [managed], { rootDir })).toMatchObject({
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 1,
    });
    expect(fs.statSync(registryPath, { bigint: true }).mtimeNs).toBe(firstMtime);

    expect(reconcileScheduledPipelines('chronos_adf', [], { rootDir })).toMatchObject({
      added: 0,
      updated: 0,
      removed: 1,
    });
    expect(loadScheduleRegistry({ rootDir }).schedules.map((schedule) => schedule.id)).toEqual([
      'manual-schedule',
    ]);
  });

  describe('QM-02 registry portability', () => {
    it('stores repo-relative paths when registering absolute in-root paths', () => {
      const rootDir = makeRootDir();
      registerScheduledPipeline(
        {
          id: 'portable',
          name: 'portable',
          pipelinePath: path.join(rootDir, 'pipelines/portable.json'),
          actuator: 'run_pipeline',
          trigger: { type: 'cron', cron: '0 6 * * *' },
          enabled: true,
        },
        { rootDir }
      );
      const registry = loadScheduleRegistry({ rootDir });
      expect(registry.schedules[0]?.pipelinePath).toBe('pipelines/portable.json');
    });

    it('migrates a legacy absolute path from another checkout via its pipelines/ segment', () => {
      expect(
        normalizeScheduledPipelinePath(
          '/Users/somebody/old-checkout/pipelines/daily.json',
          '/tmp/new-root'
        )
      ).toBe('pipelines/daily.json');
    });

    it('rejects absolute paths that cannot be made repo-relative', () => {
      expect(() => normalizeScheduledPipelinePath('/etc/passwd', '/tmp/new-root')).toThrowError(
        /repo-relative/
      );
      expect(() => normalizeScheduledPipelinePath('', '/tmp/new-root')).toThrowError(/non-empty/);
    });

    it('rejects relative traversal before a schedule can escape the repository root', () => {
      expect(() => normalizeScheduledPipelinePath('../outside.json', '/tmp/new-root')).toThrowError(
        /outside the repo/
      );
      expect(() => normalizeScheduledPipelinePath('..', '/tmp/new-root')).toThrowError(
        /outside the repo/
      );
      expect(() =>
        resolveScheduledPipelinePath(
          { pipelinePath: 'pipelines/../../etc/passwd' },
          {
            rootDir: '/tmp/new-root',
          }
        )
      ).toThrowError(/outside the repo/);
    });

    it('resolves stored relative paths against the current root', () => {
      const resolved = resolveScheduledPipelinePath(
        { pipelinePath: 'pipelines/daily.json' },
        { rootDir: '/current/root' }
      );
      expect(resolved).toBe(path.join('/current/root', 'pipelines/daily.json'));
    });

    it('keeps relative paths untouched on registration', () => {
      expect(normalizeScheduledPipelinePath('pipelines/x.json', '/any/root')).toBe(
        'pipelines/x.json'
      );
    });

    it('rejects an absolute path persisted in the registry during load', () => {
      const rootDir = makeRootDir();
      const registryPath = path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json');
      safeWriteFile(
        registryPath,
        JSON.stringify({
          version: '1.0',
          schedules: [
            {
              id: 'unsafe',
              name: 'unsafe',
              pipelinePath: '/etc/passwd',
              actuator: 'run_pipeline',
              trigger: { type: 'cron', cron: '0 6 * * *' },
              enabled: true,
            },
          ],
        })
      );
      expect(() => loadScheduleRegistry({ rootDir })).toThrowError(/repo-relative/);
    });

    it('rejects an empty path persisted in the registry during load', () => {
      const rootDir = makeRootDir();
      const registryPath = path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json');
      safeWriteFile(
        registryPath,
        JSON.stringify({
          version: '1.0',
          schedules: [
            {
              id: 'empty-path',
              name: 'empty-path',
              pipelinePath: '',
              actuator: 'run_pipeline',
              trigger: { type: 'cron', cron: '0 6 * * *' },
              enabled: true,
            },
          ],
        })
      );
      expect(() => loadScheduleRegistry({ rootDir })).toThrowError(/non-empty/);
    });

    it('fails closed when persisted schedule data violates its schema', () => {
      const rootDir = makeRootDir();
      const registryPath = path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json');
      safeWriteFile(
        registryPath,
        JSON.stringify({
          version: '1.0',
          schedules: [
            {
              id: 'invalid',
              name: 'invalid',
              pipelinePath: 'pipelines/invalid.json',
              actuator: 'run_pipeline',
              trigger: { type: 'cron', cron: '0 6 * * *' },
              enabled: true,
              unexpected: true,
            },
          ],
        })
      );

      expect(() => loadScheduleRegistry({ rootDir })).toThrowError(
        /Invalid catalog pipeline-schedule-registry/
      );
    });

    it('validates the registry before writing it', () => {
      const rootDir = makeRootDir();
      expect(() =>
        saveScheduleRegistry(
          {
            version: '1.0',
            schedules: [
              {
                id: 'invalid',
                name: 'invalid',
                pipelinePath: 'pipelines/invalid.json',
                actuator: 'run_pipeline',
                trigger: { type: 'cron', cron: '0 6 * * *' },
                enabled: true,
                unexpected: true,
              } as ScheduledPipeline & { unexpected: boolean },
            ],
          },
          { rootDir }
        )
      ).toThrowError(/Invalid catalog pipeline-schedule-registry/);
    });

    it('persists the catalog-normalized registry payload', () => {
      const rootDir = makeRootDir();
      const registry = {
        version: '1.0',
        schedules: [],
        $schema: 'governance-metadata',
      } as unknown as PipelineScheduleRegistry;

      saveScheduleRegistry(registry, { rootDir });

      const raw = JSON.parse(
        fs.readFileSync(path.join(rootDir, 'active/shared/runtime/pipeline-schedules.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(raw).toEqual({ version: '1.0', schedules: [] });
    });
  });
});

describe('operator schedule allowlist', () => {
  it('allows every schedule when no allowlist is set', () => {
    expect(scheduleAllowedByOperator('backup-daily', '')).toBe(true);
    expect(scheduleAllowedByOperator('backup-daily', undefined)).toBe(true);
  });

  it('allows only listed schedule ids when an allowlist is set', () => {
    const allowlist = ' organization-daily-digest , backup-daily ';
    expect(scheduleAllowedByOperator('organization-daily-digest', allowlist)).toBe(true);
    expect(scheduleAllowedByOperator('backup-daily', allowlist)).toBe(true);
    expect(scheduleAllowedByOperator('ai-audit', allowlist)).toBe(false);
  });

  it('treats +ids as additive opt-ins that do not restrict other schedules', () => {
    const additive = '+organization-standup, +organization-retro';
    expect(scheduleAllowedByOperator('backup-daily', additive)).toBe(true);
    expect(scheduleAllowedByOperator('organization-standup', additive)).toBe(true);
    expect(scheduleExplicitlyOptedIn('organization-retro', additive)).toBe(true);
    expect(scheduleExplicitlyOptedIn('organization-operation-tick', additive)).toBe(false);
    // Mixed with plain ids, plain ids still restrict and +ids are allowed too.
    const mixed = 'backup-daily,+organization-standup';
    expect(scheduleAllowedByOperator('backup-daily', mixed)).toBe(true);
    expect(scheduleAllowedByOperator('organization-standup', mixed)).toBe(true);
    expect(scheduleAllowedByOperator('ai-audit', mixed)).toBe(false);
  });

  it('fails closed when a set allowlist parses to no schedule ids', () => {
    for (const allowlist of [',', '  ', ' , ,', '+', ' + , ']) {
      expect(scheduleAllowedByOperator('organization-daily-digest', allowlist), allowlist).toBe(
        false
      );
    }
  });
});

describe('shipped-disabled (opt-in) schedules', () => {
  const ENV = 'KYBERION_CHRONOS_SCHEDULES';
  const previous = process.env[ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  });
  const at = new Date('2026-07-05T03:00:00+09:00');
  const optIn: ScheduledPipeline = {
    id: 'reconcile-config-fallbacks-weekly',
    name: 'Config Fallback Reconciler',
    pipelinePath: 'pipelines/reconcile-config-fallbacks.json',
    actuator: 'run_pipeline',
    enabled: false,
    optIn: true,
    trigger: { type: 'cron', cron: '0 3 * * *', timezone: 'Asia/Tokyo' },
  };

  it('stays off until the host lists its id', () => {
    delete process.env[ENV];
    expect(isScheduledPipelineDue(optIn, undefined, at)).toBe(false);
    process.env[ENV] = 'organization-daily-digest';
    expect(isScheduledPipelineDue(optIn, undefined, at)).toBe(false);
    process.env[ENV] = 'organization-daily-digest, reconcile-config-fallbacks-weekly';
    expect(isScheduledPipelineDue(optIn, undefined, at)).toBe(true);
  });

  it('never revives a schedule disabled any other way', () => {
    process.env[ENV] = 'reconcile-config-fallbacks-weekly';
    expect(isScheduledPipelineDue({ ...optIn, optIn: undefined }, undefined, at)).toBe(false);
  });

  it('treats an unset or blank env as no opt-in', () => {
    expect(scheduleExplicitlyOptedIn('x', undefined)).toBe(false);
    expect(scheduleExplicitlyOptedIn('x', '')).toBe(false);
    expect(scheduleExplicitlyOptedIn('x', ' x ,y')).toBe(true);
  });

  it('ships the reconcile pipelines disabled and the config sweep proposal-only (B1)', () => {
    for (const id of [
      'reconcile-config-fallbacks',
      'reconcile-unclassified-errors',
      'reconcile-unhandled-intents',
    ]) {
      const pipeline = JSON.parse(
        String(readRepoFile(pathResolver.rootResolve(`pipelines/${id}.json`), { encoding: 'utf8' }))
      ) as { schedule: { enabled: boolean }; steps: Array<{ op: string; params?: object }> };
      expect(pipeline.schedule.enabled, id).toBe(false);
      if (id === 'reconcile-config-fallbacks') {
        const sweep = pipeline.steps.find(
          (step) => step.op === 'system:reconcile_config_fallbacks'
        );
        expect(sweep?.params).not.toHaveProperty('apply');
      }
    }
  });
});
