import { describe, expect, it } from 'vitest';

const { parseConnectionReadinessConfig, deriveBaselineStatus, reasoningFailoverWarning } =
  await import(new URL('./run_baseline_check.js', import.meta.url).href);

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
});
