import { describe, expect, it } from 'vitest';
import {
  evaluateOpsHealth,
  formatOpsHealthFinding,
  isSchedulerOpsFinding,
  latestMissedCronOccurrence,
  DEFAULT_RESIDENT_SERVICES,
  type InstalledUnit,
  type OpsHealthInput,
} from './ops-health.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function unit(overrides: Partial<InstalledUnit> = {}): InstalledUnit {
  return {
    id: 'chronos',
    label: 'com.kyberion.chronos.ws-0123456789abcdef',
    scope: 'scoped',
    repoRoot: '/repo',
    ownedByThisCheckout: true,
    loaded: true,
    ...overrides,
  };
}

/** A fully healthy observation set; each case overrides one field. */
function healthy(overrides: Partial<OpsHealthInput> = {}): OpsHealthInput {
  return {
    schedules: [
      {
        id: 'daily',
        enabled: true,
        pipelinePath: 'pipelines/daily.json',
        trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'UTC' },
        lastRun: iso(-6 * HOUR),
        lastStatus: 'succeeded',
        consecutiveFailures: 0,
      },
      {
        id: 'backup-daily',
        enabled: true,
        trigger: { type: 'cron', cron: '0 3 * * *', timezone: 'UTC' },
        lastRun: iso(-9 * HOUR),
        lastStatus: 'succeeded',
      },
      {
        id: 'tick',
        enabled: true,
        trigger: { type: 'interval', intervalMs: HOUR },
        lastRun: iso(-30 * 60 * 1000),
        lastStatus: 'succeeded',
      },
    ],
    declaredEnabledScheduleCount: 2,
    excludedScheduleIds: [],
    heartbeat: {
      status: 'healthy',
      process_status: 'running',
      pid: 4242,
      started_at: iso(-48 * HOUR),
      restarts_1h: 0,
      restarts_24h: 0,
      last_tick_ok_at: iso(-60 * 1000),
    },
    backup: { status: 'fresh', latestName: 'kyberion-backup.tar.gz.enc', latestAgeHours: 9 },
    drillReceipt: { completed_at: iso(-5 * 24 * HOUR), archive: '/backups/a.tar.gz.enc', ok: true },
    janitor: { last_run_ms: NOW.getTime() - 8 * HOUR, last_failure: null },
    installedUnits: {
      platform: 'darwin',
      instanceId: 'ws-0123456789abcdef',
      repoRoot: '/repo',
      units: [
        unit(),
        unit({ id: 'daemon-watchdog', label: 'com.kyberion.daemon-watchdog.ws-0123456789abcdef' }),
      ],
    },
    residentServices: [...DEFAULT_RESIDENT_SERVICES],
    enabledSurfaces: [],
    triggerStore: {
      path: 'runtime/trigger-deliveries.jsonl',
      size_bytes: 1024,
      cap_bytes: 5 * 1024 * 1024,
    },
    ...overrides,
  };
}

const ids = (input: OpsHealthInput) => evaluateOpsHealth(input, NOW).findings.map((f) => f.id);

describe('evaluateOpsHealth', () => {
  it('reports no findings for a healthy installation', () => {
    expect(evaluateOpsHealth(healthy(), NOW).findings).toEqual([]);
  });

  const cases: Array<{ name: string; input: OpsHealthInput; expected: string }> = [
    {
      name: 'cron schedule overdue (missed occurrence older than 2h grace)',
      input: healthy({
        schedules: [
          {
            id: 'daily',
            enabled: true,
            pipelinePath: 'pipelines/daily.json',
            trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'UTC' },
            lastRun: iso(-30 * HOUR),
          },
        ],
      }),
      expected: 'schedule-overdue:daily',
    },
    {
      name: 'interval schedule overdue (last run older than 2 intervals)',
      input: healthy({
        schedules: [
          {
            id: 'tick',
            enabled: true,
            trigger: { type: 'interval', intervalMs: HOUR },
            lastRun: iso(-3 * HOUR),
          },
        ],
      }),
      expected: 'schedule-overdue:tick',
    },
    {
      name: 'schedule failing (lastStatus failed)',
      input: healthy({
        schedules: [
          {
            id: 'daily',
            enabled: true,
            trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'UTC' },
            lastRun: iso(-6 * HOUR),
            lastStatus: 'failed',
            consecutiveFailures: 2,
          },
        ],
      }),
      expected: 'schedule-failing:daily',
    },
    {
      name: 'schedule auto-disabled after failures',
      input: healthy({
        schedules: [
          {
            id: 'daily',
            enabled: false,
            trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'UTC' },
            disabledReason: 'auto-disabled after 5 consecutive failures',
          },
        ],
        declaredEnabledScheduleCount: 0,
      }),
      expected: 'schedule-failing:daily',
    },
    {
      name: 'crash loop (>3 restarts in the last hour)',
      input: healthy({
        heartbeat: { ...healthy().heartbeat!, restarts_1h: 5, restarts_24h: 40 },
      }),
      expected: 'scheduler-crash-loop',
    },
    {
      name: 'tick failing (last tick error newer than last ok tick)',
      input: healthy({
        heartbeat: {
          ...healthy().heartbeat!,
          process_status: 'error',
          last_tick_error: 'trigger store unreadable',
          last_tick_error_at: iso(-30 * 1000),
        },
      }),
      expected: 'scheduler-tick-failing',
    },
    {
      name: 'backup archive older than 36h',
      input: healthy({ backup: { status: 'stale', latestName: 'old.tar.gz', latestAgeHours: 50 } }),
      expected: 'backup-archive-stale',
    },
    {
      name: 'backup archive missing',
      input: healthy({ backup: { status: 'missing', latestName: null, latestAgeHours: null } }),
      expected: 'backup-archive-missing',
    },
    {
      name: 'backup-daily failed',
      input: healthy({
        schedules: [
          {
            id: 'backup-daily',
            enabled: true,
            trigger: { type: 'cron', cron: '0 3 * * *', timezone: 'UTC' },
            lastRun: iso(-9 * HOUR),
            lastStatus: 'failed',
          },
        ],
      }),
      expected: 'backup-daily-failed',
    },
    {
      name: 'restore drill receipt missing',
      input: healthy({ drillReceipt: null }),
      expected: 'backup-drill-missing',
    },
    {
      name: 'restore drill older than 35 days',
      input: healthy({
        drillReceipt: { completed_at: iso(-40 * 24 * HOUR), archive: 'a', ok: true },
      }),
      expected: 'backup-drill-stale',
    },
    {
      name: 'restore drill failed',
      input: healthy({
        drillReceipt: {
          completed_at: iso(-HOUR),
          archive: null,
          ok: false,
          reason: 'failed',
          error: 'decrypt failed',
        },
      }),
      expected: 'backup-drill-failed',
    },
    {
      name: 'restore drill skipped for lack of an archive',
      input: healthy({
        drillReceipt: { completed_at: iso(-HOUR), archive: null, ok: false, reason: 'no_archive' },
      }),
      expected: 'backup-drill-no-archive',
    },
    {
      name: 'janitor marker older than 48h',
      input: healthy({ janitor: { last_run_ms: NOW.getTime() - 50 * HOUR } }),
      expected: 'janitor-stale',
    },
    {
      name: 'janitor baseline run failed after the last completed run',
      input: healthy({
        janitor: {
          last_run_ms: NOW.getTime() - 8 * HOUR,
          last_failure: {
            failed_at: iso(-HOUR),
            exit_code: 1,
            log_path: 'active/shared/logs/process/baseline-janitor-maintenance.log',
          },
        },
      }),
      expected: 'janitor-failed',
    },
    {
      name: 'registry empty while pipelines declare enabled schedules',
      input: healthy({ schedules: [], declaredEnabledScheduleCount: 25 }),
      expected: 'schedule-registry-empty',
    },
    {
      name: 'required unit missing',
      input: healthy({
        installedUnits: { ...healthy().installedUnits!, units: [unit()] },
      }),
      expected: 'unit-missing:daemon-watchdog',
    },
    {
      name: 'unit root differs from this checkout',
      input: healthy({
        installedUnits: {
          ...healthy().installedUnits!,
          units: [
            unit({ repoRoot: '/other/checkout' }),
            unit({ id: 'daemon-watchdog', label: 'com.kyberion.daemon-watchdog.ws-x' }),
          ],
        },
      }),
      expected: 'unit-foreign-root:chronos',
    },
    {
      name: 'legacy unit owned by this checkout',
      input: healthy({
        installedUnits: {
          ...healthy().installedUnits!,
          units: [
            unit({ scope: 'legacy', label: 'com.kyberion.chronos' }),
            unit({ id: 'daemon-watchdog', label: 'com.kyberion.daemon-watchdog.ws-x' }),
          ],
        },
      }),
      expected: 'unit-legacy-owned:chronos',
    },
    {
      name: 'unit installed while its surface owner is enabled',
      input: healthy({
        enabledSurfaces: ['generation-schedule'],
        installedUnits: {
          ...healthy().installedUnits!,
          units: [
            ...healthy().installedUnits!.units,
            unit({ id: 'generation-schedule', label: 'com.kyberion.generation-schedule.ws-x' }),
          ],
        },
      }),
      expected: 'unit-double-owner:generation-schedule',
    },
    {
      name: 'trigger delivery store above 80% of its read cap',
      input: healthy({
        triggerStore: {
          path: 'runtime/trigger-deliveries.jsonl',
          size_bytes: 4.5 * 1024 * 1024,
          cap_bytes: 5 * 1024 * 1024,
        },
      }),
      expected: 'trigger-store-near-cap',
    },
  ];

  cases.push({
    name: 'backup-daily enabled but the passphrase is unreachable',
    input: healthy({
      backupPassphrase: {
        available: false,
        source: null,
        reason: '[BACKUP_PASSPHRASE_MISSING] No backup passphrase',
      },
    }),
    expected: 'backup-passphrase-unavailable',
  });

  it('a reachable passphrase raises no finding', () => {
    expect(
      ids(
        healthy({ backupPassphrase: { available: true, source: 'secret', backend: 'os_keychain' } })
      )
    ).toEqual([]);
  });

  it.each(cases)('$name → $expected', ({ input, expected }) => {
    const findings = evaluateOpsHealth(input, NOW).findings;
    const finding = findings.find((entry) => entry.id === expected);
    expect(finding, JSON.stringify(findings, null, 2)).toBeDefined();
    // `next` must always name a concrete command.
    expect(finding!.next).toMatch(/pnpm /);
    expect(finding!.reason.length).toBeGreaterThan(0);
  });

  it('does not flag overdue right after chronos (re)started', () => {
    const input = healthy({
      heartbeat: { ...healthy().heartbeat!, started_at: iso(-10 * 60 * 1000) },
      schedules: [
        {
          id: 'daily',
          enabled: true,
          trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'UTC' },
          lastRun: iso(-30 * HOUR),
        },
      ],
    });
    expect(ids(input)).not.toContain('schedule-overdue:daily');
  });

  it('does not flag schedules excluded by the operator allowlist or disabled', () => {
    const stale = {
      enabled: true,
      trigger: { type: 'cron' as const, cron: '0 6 * * *', timezone: 'UTC' },
      lastRun: iso(-30 * HOUR),
    };
    expect(
      ids(
        healthy({
          schedules: [
            { id: 'excluded', ...stale },
            { id: 'off', ...stale, enabled: false },
          ],
          excludedScheduleIds: ['excluded'],
        })
      ).filter((id) => id.startsWith('schedule-overdue'))
    ).toEqual([]);
  });

  it('skips unit findings when units were not inspected, and the empty-registry finding when nothing is declared', () => {
    const findings = ids(
      healthy({ installedUnits: null, schedules: [], declaredEnabledScheduleCount: 0 })
    );
    expect(findings.filter((id) => id.startsWith('unit-'))).toEqual([]);
    expect(findings).not.toContain('schedule-registry-empty');
  });

  it('classifies scheduler findings for L10 and the rest for L12', () => {
    const report = evaluateOpsHealth(
      healthy({
        drillReceipt: null,
        heartbeat: { ...healthy().heartbeat!, restarts_1h: 9 },
      }),
      NOW
    );
    const scheduler = report.findings.filter(isSchedulerOpsFinding).map((f) => f.id);
    const resident = report.findings.filter((f) => !isSchedulerOpsFinding(f)).map((f) => f.id);
    expect(scheduler).toEqual(['scheduler-crash-loop']);
    expect(resident).toEqual(['backup-drill-missing']);
    expect(formatOpsHealthFinding(report.findings[0]!)).toMatch(
      /^ERROR scheduler-crash-loop: .* \| next: pnpm kyberion scheduler status/
    );
  });

  it('latestMissedCronOccurrence stops at lastRun', () => {
    const ceiling = NOW.getTime() - 2 * HOUR;
    expect(
      latestMissedCronOccurrence('0 6 * * *', 'UTC', ceiling, NOW.getTime() - 6 * HOUR)
    ).toBeNull();
    expect(latestMissedCronOccurrence('0 6 * * *', 'UTC', ceiling, NOW.getTime() - 30 * HOUR)).toBe(
      Date.parse('2026-11-01T06:00:00.000Z')
    );
  });
});
