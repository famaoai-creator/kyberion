import { describe, expect, it } from 'vitest';
import { formatMissionExecutionReadiness } from './mission-execution-readiness.js';

const observed = [{ provider: 'codex', installed: true, healthy: true }];
describe('mission execution readiness', () => {
  it('does not present cached provider health or task closure as successful execution', () => {
    const lines = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'acme',
      runtimeReason: 'Not probed',
      structural: 'satisfied',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'acme',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'confidential',
            usable: [],
            denied: [{ provider: 'codex', reason: 'attestation expired' }],
            note: '',
          },
        ],
      },
    });
    expect(lines.join('\n')).toContain('blocked');
    expect(lines.join('\n')).toContain('attestation expired');
    expect(lines.join('\n')).toContain('not proof of model execution');
    expect(lines.join('\n')).not.toContain('codex ready');
  });
  it('does not call an allowed provider runnable', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'public',
      runtimeReason: 'Not probed',
      structural: 'not_assessed',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'acme',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'public',
            usable: [{ provider: 'codex', basis: 'public' }],
            denied: [],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('egress allowed');
    expect(text).toContain('runtime unverified');
  });
  it('does not let a missing local runtime hide a blocked installed external provider', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'acme',
      runtimeReason: 'Not probed',
      structural: 'unsatisfied',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'acme',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'confidential',
            usable: [{ provider: 'laya-mlx', basis: 'local-only' }],
            denied: [{ provider: 'codex', reason: 'expired' }],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('codex: blocked');
    expect(text).not.toContain('laya-mlx: egress allowed');
  });
  it('does not use another tier to report permission', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'acme',
      runtimeReason: 'Not probed',
      structural: 'not_assessed',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'acme',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'public',
            usable: [{ provider: 'codex', basis: 'public' }],
            denied: [],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('permission unverified');
    expect(text).not.toContain('egress allowed');
  });
  it('keeps missing policy and missing observations unknown', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      runtimeReason: 'Not probed',
      structural: 'not_assessed',
      providers: [],
      availability: null,
    }).join('\n');
    expect(text).toContain('No installed provider observation');
    expect(text).toContain('permission unverified');
  });

  it('refuses a permission report for another tenant', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'alpha',
      runtimeReason: 'Not probed',
      structural: 'satisfied',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'beta',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'confidential',
            usable: [{ provider: 'codex', basis: 'tenant-attestation' }],
            denied: [],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('permission unverified');
    expect(text).not.toContain('egress allowed');
  });
  it('does not accept ambient tenant selection as a mission-bound observation', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'alpha',
      runtimeReason: 'Not probed',
      structural: 'satisfied',
      providers: observed,
      availability: {
        policy_status: 'ok',
        tenant_slug: 'alpha',
        tenant_source: 'ambient',
        tiers: [
          {
            tier: 'confidential',
            usable: [{ provider: 'codex', basis: 'tenant-attestation' }],
            denied: [],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('permission unverified');
    expect(text).not.toContain('egress allowed');
  });

  it('shows expired declared permission even when no provider installation was observed', () => {
    const text = formatMissionExecutionReadiness({
      tier: 'confidential',
      tenantSlug: 'acme',
      runtimeReason: 'Not probed',
      structural: 'satisfied',
      providers: [],
      availability: {
        policy_status: 'ok',
        tenant_slug: 'acme',
        tenant_source: 'argument',
        tiers: [
          {
            tier: 'confidential',
            usable: [],
            denied: [{ provider: 'codex', reason: 'attestation expired' }],
            note: '',
          },
        ],
      },
    }).join('\n');
    expect(text).toContain('codex: blocked');
    expect(text).toContain('attestation expired');
    expect(text).toContain('installation unobserved');
  });
});
