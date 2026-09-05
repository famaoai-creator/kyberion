import { describe, expect, it, vi } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import {
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
  type ProviderCapability,
} from '@agent/core';

// XP-01: this file's top-level import below runs `run_baseline_check.ts`'s
// `main()` for real (unconditional `main().catch(...)` at module scope — see
// the existing tests below, which already exercise real tenant-drift/cowork-
// health checks this way). Without this kill switch, adding the provider-
// capability-registry population job to `main()` would make every run of
// this test file spawn real `claude --version` / `codex --help` / `gh auth
// status` etc. subprocesses. Must be set before the dynamic import.
process.env.KYBERION_PROVIDER_CAPABILITY_PROBE = '0';

const {
  parseConnectionReadinessConfig,
  deriveBaselineStatus,
  reasoningFailoverWarning,
  summarizeProviderCapabilities,
  resolveProviderCapabilitiesSnapshot,
  PROVIDER_CAPABILITY_PROBE_ENV,
  isJanitorMarkerFresh,
  JANITOR_FRESHNESS_MAX_AGE_MS,
  evaluateSchedulerHealth,
  schedulerHealthEvaluationFailure,
  cronFiredWithinWindow,
  shouldEmitDailyOpsAlert,
  SCHEDULES_FIRING_WINDOW_MS,
  readAuditLedgerFreshness,
  AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS,
} = await import(new URL('./run_baseline_check.js', import.meta.url).href);

function fakeCapability(overrides: Partial<ProviderCapability> = {}): ProviderCapability {
  return {
    provider_id: 'claude',
    binary_found: true,
    authenticated: 'unknown',
    headless: true,
    structured_output: true,
    models: ['claude-sonnet'],
    probed_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('run_baseline_check', () => {
  it('uses the canonical readiness loader for the runtime config', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/run_baseline_check.ts'));
    expect(source).toContain('loadServiceConnectionReadinessConfig()');
    expect(source).not.toContain('const raw = safeReadFile(configPath');
  });

  it('keeps the baseline CLI exit boundary inside the shared harness', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/run_baseline_check.ts'));

    expect(source).not.toContain('process.exitCode');
    expect(source).toContain("new ScriptExitError(1, '', true, report)");
    expect(source).toContain('runBaselineCheckCli = defineScript');
    expect(source).toContain('readTextFile');
  });

  it('marks readiness config as degraded when parse fails', () => {
    const result = parseConnectionReadinessConfig('{broken-json', 'fixture.json');

    expect(result).toEqual({
      requiredServices: {},
      tenantGuard: { requireZeroDrift: true },
      configDegraded: true,
    });
  });

  it('parses readiness config without degrading when valid', () => {
    const result = parseConnectionReadinessConfig(
      JSON.stringify({
        required_services: {
          calendar: { required_keys_any: ['token'] },
        },
        tenant_guard: {
          require_zero_drift: false,
        },
      }),
      'fixture.json'
    );

    expect(result).toEqual({
      requiredServices: {
        calendar: { required_keys_any: ['token'] },
      },
      tenantGuard: { requireZeroDrift: false },
      configDegraded: false,
    });
  });

  it('returns needs_attention when janitor maintenance is pending', () => {
    const status = deriveBaselineStatus(
      { success: true, failedLayer: null },
      { submitted: false, pending: true, reason: 'storage janitor job is already pending' }
    );

    expect(status).toBe('needs_attention');
  });

  it('keeps all_clear when baseline is healthy and no janitor maintenance is pending', () => {
    const status = deriveBaselineStatus(
      { success: true, failedLayer: null },
      { submitted: false, pending: false, reason: null }
    );

    expect(status).toBe('all_clear');
  });

  it('returns needs_attention when the reasoning chain degraded to stub (LC-08)', () => {
    const status = deriveBaselineStatus(
      { success: true, failedLayer: null },
      { submitted: false, pending: false, reason: null },
      true
    );

    expect(status).toBe('needs_attention');
  });

  // XP-05: failover-active is a warning field, not a status input — a
  // healthy chain that failed over stays `all_clear`/`needs_onboarding`/etc.
  // exactly as before; only the extra `warnings.reasoning_failover` string
  // changes.
  it('does not change status when a provider failover marker is present (XP-05, non-blocking)', () => {
    const status = deriveBaselineStatus(
      { success: true, failedLayer: null },
      { submitted: false, pending: false, reason: null },
      false
    );
    expect(status).toBe('all_clear');
  });

  // AL-01: L8 Storage Hygiene Layer — janitor last-run freshness.
  it('isJanitorMarkerFresh treats a missing marker as stale ("never ran" must not look healthy)', () => {
    expect(isJanitorMarkerFresh(null)).toBe(false);
  });

  it('isJanitorMarkerFresh accepts a marker within 48h and rejects one beyond it', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    expect(isJanitorMarkerFresh(now - 60 * 60 * 1000, now)).toBe(true); // 1h old
    expect(isJanitorMarkerFresh(now - JANITOR_FRESHNESS_MAX_AGE_MS, now)).toBe(true); // exact boundary
    expect(isJanitorMarkerFresh(now - JANITOR_FRESHNESS_MAX_AGE_MS - 1, now)).toBe(false); // just past
  });

  it('a failed L8 (stale janitor) degrades the baseline to needs_attention', () => {
    const status = deriveBaselineStatus(
      { success: false, failedLayer: 'L8' },
      { submitted: false, pending: false, reason: null }
    );
    expect(status).toBe('needs_attention');
  });

  it('readAuditLedgerFreshness distinguishes missing, stale, and fresh audit ledgers (EG-03)', () => {
    const auditDir = pathResolver.sharedTmp('baseline-audit-ledger-freshness-test');
    safeRmSync(auditDir, { recursive: true, force: true });
    safeMkdir(auditDir, { recursive: true });
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    expect(readAuditLedgerFreshness(auditDir, now)).toMatchObject({
      fresh: false,
      reason: 'missing',
    });
    safeWriteFile(
      `${auditDir}/audit-2026-08-09.jsonl`,
      JSON.stringify({
        timestamp: new Date(now - AUDIT_LEDGER_FRESHNESS_MAX_AGE_MS - 1).toISOString(),
      })
    );
    expect(readAuditLedgerFreshness(auditDir, now)).toMatchObject({
      fresh: false,
      reason: 'stale',
    });
    safeWriteFile(
      `${auditDir}/audit-2026-08-09.jsonl`,
      JSON.stringify({ timestamp: new Date(now - 60 * 60 * 1000).toISOString() })
    );
    expect(readAuditLedgerFreshness(auditDir, now)).toMatchObject({ fresh: true, reason: 'fresh' });
    const target = `${auditDir}/audit-target.jsonl`;
    const linked = `${auditDir}/audit-2026-08-10.jsonl`;
    safeWriteFile(target, JSON.stringify({ timestamp: new Date(now).toISOString() }));
    safeSymlinkSync(target, linked);
    safeRmSync(`${auditDir}/audit-2026-08-09.jsonl`, { force: true });
    expect(readAuditLedgerFreshness(auditDir, now)).toMatchObject({
      fresh: false,
      reason: 'missing',
    });
    safeRmSync(auditDir, { recursive: true, force: true });
  });

  it('reasoningFailoverWarning returns null when no marker is present', () => {
    expect(reasoningFailoverWarning(null)).toBeNull();
  });

  it('reasoningFailoverWarning surfaces from/to/method when a marker is present', () => {
    const warning = reasoningFailoverWarning({
      from_mode: 'claude-agent',
      to_mode: 'codex-cli',
      provider_from: 'claude',
      provider_to: 'codex',
      method: 'delegateTask',
      at: '2026-07-25T00:00:00.000Z',
    });
    expect(warning).toContain('claude-agent');
    expect(warning).toContain('codex-cli');
    expect(warning).toContain('delegateTask');
    expect(warning).toContain('2026-07-25T00:00:00.000Z');
  });

  // XP-01: provider-capability-registry population job. Every case here
  // drives `resolveProviderCapabilitiesSnapshot` with an injected fake
  // peek/load — never the real exec seam — so these tests stay hermetic
  // even though the module under test also runs the real thing once (with
  // probing disabled) as a side effect of the top-level import above.
  describe('provider capability population job (XP-01)', () => {
    it('summarizes an available (binary found, authenticated or unknown) provider', () => {
      const summary = summarizeProviderCapabilities([
        fakeCapability({ provider_id: 'claude', binary_found: true, authenticated: 'unknown' }),
        fakeCapability({ provider_id: 'copilot', binary_found: true, authenticated: true }),
      ]);
      expect(summary.probed_at).toBe('2026-07-25T00:00:00.000Z');
      expect(summary.available).toEqual(['claude', 'copilot']);
      expect(summary.excluded).toEqual([]);
    });

    it('excludes providers with no binary or a failed auth probe, with a reason', () => {
      const summary = summarizeProviderCapabilities([
        fakeCapability({
          provider_id: 'codex',
          binary_found: false,
          authenticated: false,
          probe_error: 'spawn ENOENT',
        }),
        fakeCapability({ provider_id: 'copilot', binary_found: true, authenticated: false }),
      ]);
      expect(summary.available).toEqual([]);
      expect(summary.excluded).toEqual([
        { provider: 'codex', reason: 'spawn ENOENT' },
        { provider: 'copilot', reason: 'not authenticated' },
      ]);
    });

    it('(a) absent/stale registry (peek → null) triggers a load and the summary reflects it', () => {
      const peek = vi.fn().mockReturnValue(null);
      const load = vi.fn().mockReturnValue([fakeCapability()]);
      const snapshot = resolveProviderCapabilitiesSnapshot({
        probingEnabled: true,
        peek,
        load,
        now: () => Date.parse('2026-07-25T00:05:00.000Z'),
      });

      expect(peek).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(snapshot.cached).toBe(false);
      expect(snapshot.probing_enabled).toBe(true);
      expect(snapshot.summary.available).toEqual(['claude']);
      expect(snapshot.age_ms).toBe(5 * 60 * 1000);
    });

    it('(b) fresh registry (peek → non-null) is reported as cached, no forced re-probe', () => {
      // The "no re-probe within TTL" behavior itself lives in and is already
      // covered by libs/core/provider-capability-registry.test.ts
      // ("re-probes on TTL expiry using an injectable clock"); this test only
      // asserts run_baseline_check's own report-shape responsibility: a fresh
      // peek must be surfaced as `cached: true` in the baseline report.
      const peek = vi.fn().mockReturnValue([fakeCapability()]);
      const load = vi.fn().mockReturnValue([fakeCapability()]);
      const snapshot = resolveProviderCapabilitiesSnapshot({
        probingEnabled: true,
        peek,
        load,
        now: () => Date.parse('2026-07-25T00:00:00.000Z'),
      });

      expect(snapshot.cached).toBe(true);
      expect(snapshot.summary.available).toEqual(['claude']);
    });

    it('(c) a broken registry read/probe degrades to an empty summary without throwing', () => {
      const peek = vi.fn(() => {
        throw new Error('registry file corrupt');
      });
      const load = vi.fn().mockReturnValue([fakeCapability()]);

      const snapshot = resolveProviderCapabilitiesSnapshot({ probingEnabled: true, peek, load });

      expect(snapshot).toEqual({
        summary: { probed_at: null, available: [], excluded: [] },
        cached: false,
        age_ms: null,
        probing_enabled: true,
      });
    });

    it('(c) all providers reporting unavailable still produces a well-formed, non-throwing summary', () => {
      const summary = summarizeProviderCapabilities([
        fakeCapability({
          provider_id: 'codex',
          binary_found: false,
          authenticated: false,
          probe_error: 'spawn ENOENT',
        }),
      ]);
      expect(summary.available).toEqual([]);
      expect(summary.excluded).toEqual([{ provider: 'codex', reason: 'spawn ENOENT' }]);
      // deriveBaselineStatus never receives provider capability data at all,
      // so a fully-degraded probe cannot change baseline status by
      // construction — verified independently by the deriveBaselineStatus
      // tests above, which never pass a provider-capabilities argument.
    });

    it('(d) probe kill-switch (KYBERION_PROVIDER_CAPABILITY_PROBE=0) skips peek/load entirely', () => {
      expect(PROVIDER_CAPABILITY_PROBE_ENV).toBe('KYBERION_PROVIDER_CAPABILITY_PROBE');

      const peek = vi.fn();
      const load = vi.fn();
      const snapshot = resolveProviderCapabilitiesSnapshot({ probingEnabled: false, peek, load });

      expect(peek).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
      expect(snapshot).toEqual({
        summary: { probed_at: null, available: [], excluded: [] },
        cached: false,
        age_ms: null,
        probing_enabled: false,
      });
    });
  });

  // LC-01a: L10 Scheduler Layer — chronos liveness + schedules firing.
  describe('scheduler health (LC-01)', () => {
    const NOW = new Date('2026-08-08T12:00:00.000Z');

    function cronSchedule(overrides: Record<string, unknown> = {}) {
      return {
        id: 'daily',
        name: 'daily',
        pipelinePath: 'pipelines/daily-routine.json',
        actuator: 'run_pipeline',
        trigger: { type: 'cron', cron: '0 6 * * *', timezone: 'Asia/Tokyo' },
        enabled: true,
        ...overrides,
      };
    }

    const healthyHeartbeat = {
      daemon_id: 'chronos-daemon',
      status: 'healthy',
      age_ms: 30_000,
      heartbeat: {
        daemon_id: 'chronos-daemon',
        pid: 4242,
        status: 'running',
        timestamp: '2026-08-08T11:59:30.000Z',
      },
    };
    const missingHeartbeat = {
      daemon_id: 'chronos-daemon',
      status: 'missing',
      reason: 'heartbeat file is missing',
    };

    it('cronFiredWithinWindow: a daily cron fired within a 24h window; a weekly one off-day did not', () => {
      // 0 6 * * * UTC fired at 06:00 today, inside the window ending at noon.
      expect(cronFiredWithinWindow('0 6 * * *', undefined, NOW, SCHEDULES_FIRING_WINDOW_MS)).toBe(
        true
      );
      // 2026-08-08 is a Saturday; a Monday-only cron did not fire in 24h.
      expect(cronFiredWithinWindow('0 7 * * 1', undefined, NOW, SCHEDULES_FIRING_WINDOW_MS)).toBe(
        false
      );
    });

    it('a fresh environment (no enabled schedules) is healthy even with a missing heartbeat', () => {
      const report = evaluateSchedulerHealth({
        schedules: [cronSchedule({ enabled: false })],
        heartbeat: missingHeartbeat,
        pidAlive: () => false,
        now: NOW,
      });
      expect(report.healthy).toBe(true);
      expect(report.enabled_schedule_count).toBe(0);
      expect(report.scheduler_alive.ok).toBe(true);
      expect(report.schedules_firing.ok).toBe(true);
    });

    it('enabled schedules + missing/stale heartbeat fails scheduler_alive', () => {
      const report = evaluateSchedulerHealth({
        schedules: [cronSchedule()],
        heartbeat: missingHeartbeat,
        pidAlive: () => true,
        now: NOW,
        cronFired: () => true,
      });
      expect(report.scheduler_alive.ok).toBe(false);
      expect(report.scheduler_alive.reason).toContain('missing');
      expect(report.healthy).toBe(false);
    });

    it('a fresh heartbeat whose pid is dead fails scheduler_alive', () => {
      const report = evaluateSchedulerHealth({
        schedules: [cronSchedule()],
        heartbeat: healthyHeartbeat,
        pidAlive: () => false,
        now: NOW,
        cronFired: () => true,
      });
      expect(report.scheduler_alive.ok).toBe(false);
      expect(report.scheduler_alive.reason).toContain('4242');
    });

    it('due schedules with no lastRun in 24h fail schedules_firing; a recent lastRun passes', () => {
      const base = {
        heartbeat: healthyHeartbeat,
        pidAlive: () => true,
        now: NOW,
        cronFired: () => true,
      };
      const stale = evaluateSchedulerHealth({
        ...base,
        schedules: [cronSchedule({ lastRun: '2026-08-01T21:00:00.000Z' })],
      });
      expect(stale.schedules_firing.ok).toBe(false);
      expect(stale.schedules_firing.due_in_window).toBe(1);
      expect(stale.healthy).toBe(false);

      const fresh = evaluateSchedulerHealth({
        ...base,
        schedules: [
          cronSchedule({ lastRun: '2026-08-01T21:00:00.000Z' }),
          cronSchedule({ id: 'other', lastRun: '2026-08-08T06:00:00.000Z' }),
        ],
      });
      expect(fresh.schedules_firing.ok).toBe(true);
      expect(fresh.healthy).toBe(true);
    });

    it('schedules that were never due in the window do not fail schedules_firing', () => {
      const report = evaluateSchedulerHealth({
        schedules: [cronSchedule({ trigger: { type: 'cron', cron: '0 7 * * 1' } })],
        heartbeat: healthyHeartbeat,
        pidAlive: () => true,
        now: NOW,
        cronFired: () => false,
      });
      expect(report.schedules_firing.ok).toBe(true);
      expect(report.schedules_firing.due_in_window).toBe(0);
    });

    it('a failed L10 (dead scheduler) degrades the baseline to needs_attention, never fatal', () => {
      const status = deriveBaselineStatus(
        { success: false, failedLayer: 'L10' },
        { submitted: false, pending: false, reason: null }
      );
      expect(status).toBe('needs_attention');
    });

    it('fails closed when scheduler health cannot be evaluated', () => {
      const report = schedulerHealthEvaluationFailure('schedule registry unreadable');
      expect(report.healthy).toBe(false);
      expect(report.scheduler_alive.ok).toBe(false);
      expect(report.scheduler_alive.reason).toContain('schedule registry unreadable');
      expect(report.schedules_firing.ok).toBe(false);
    });

    // LC-01b: day-level dedup so hourly baseline runs emit one alert per day.
    it('shouldEmitDailyOpsAlert gates per key per UTC day and fails open on bad markers', () => {
      expect(shouldEmitDailyOpsAlert(null, 'scheduler_alive', NOW)).toBe(true);
      expect(
        shouldEmitDailyOpsAlert({ scheduler_alive: '2026-08-08' }, 'scheduler_alive', NOW)
      ).toBe(false);
      expect(
        shouldEmitDailyOpsAlert({ scheduler_alive: '2026-08-07' }, 'scheduler_alive', NOW)
      ).toBe(true);
      expect(
        shouldEmitDailyOpsAlert({ failed_schedules: '2026-08-08' }, 'scheduler_alive', NOW)
      ).toBe(true);
    });
  });
});
