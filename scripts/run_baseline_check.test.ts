import { describe, expect, it } from 'vitest';

const { parseConnectionReadinessConfig } = await import(
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
});
