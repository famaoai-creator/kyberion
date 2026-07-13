import { describe, expect, it } from 'vitest';

const { parseConnectionReadinessConfig, deriveBaselineStatus } = await import(
  new URL('./run_baseline_check.js', import.meta.url).href
);

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
});
