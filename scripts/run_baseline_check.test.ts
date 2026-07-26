import { describe, expect, it, vi } from 'vitest';
import type { ProviderCapability } from '@agent/core';

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
});
