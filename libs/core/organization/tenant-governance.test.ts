import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

import { withExecutionContext } from '../authority.js';
import { auditChain } from '../governance/audit-chain.js';
import { checkProviderEgress } from '../provider/provider-egress-gate.js';
import { attestTenantProvider, mutateTenant } from './tenant-governance.js';
import { readTenantProfile, recordTenantProviderAttestation } from './tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

describe('tenant lifecycle preserves provider policy state', () => {
  const parent = pathResolver.sharedTmp('tenant-governance-preserve-tests');
  let rootDir = '';

  beforeEach(() => {
    rootDir = path.join(parent, `fixture-${process.pid}-${Date.now()}-${Math.random()}`);
    safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    withExecutionContext('sovereign_concierge', () =>
      safeWriteFile(
        path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
          allowed_reasoning_backends: ['claude'],
          provider_attestations: {
            claude: {
              training_use: 'none',
              plan: 'paid',
              attested_at: '2026-09-20T00:00:00.000Z',
            },
          },
        })
      )
    );
  });

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('keeps the allowlist and attestations when the governed tenant facade updates metadata', () => {
    const result = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({
        verb: 'update',
        slug: 'acme',
        displayName: 'Acme Renamed',
        rootDir,
        apply: true,
      })
    );

    expect(result.profile.display_name).toBe('Acme Renamed');
    expect(result.profile.allowed_reasoning_backends).toEqual(['claude']);
    expect(result.profile.provider_attestations?.claude).toMatchObject({
      training_use: 'none',
      plan: 'paid',
    });
    expect(
      withExecutionContext('mission_controller', () => readTenantProfile('acme', { rootDir }))
    ).toMatchObject({
      allowed_reasoning_backends: ['claude'],
      provider_attestations: { claude: { training_use: 'none' } },
    });
  });

  it('creates new tenants strictly isolated so activation can pass memory_policy', () => {
    const result = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'create', slug: 'beta', displayName: 'Beta', rootDir, apply: true })
    );
    expect(result.profile.isolation_policy).toEqual({
      strict_isolation: true,
      allow_cross_distillation: false,
    });
    // An update never invents a policy the existing profile did not declare.
    const updated = withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'update', slug: 'acme', displayName: 'Acme', rootDir, apply: true })
    );
    expect(updated.profile.isolation_policy).toBeUndefined();
  });

  it('requires evidence and attribution for a non-training attestation', () => {
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        recordTenantProviderAttestation({
          slug: 'acme',
          provider: 'codex',
          training_use: 'none',
          rootDir,
        })
      )
    ).toThrow('requires plan, basis, attested_by');
  });

  it('records an audited attestation that opens confidential egress for that tenant only', () => {
    const record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
    try {
      withExecutionContext('sovereign_concierge', () =>
        mutateTenant({ verb: 'create', slug: 'beta', rootDir, apply: true })
      );
      const egress = (slug: string) =>
        checkProviderEgress({
          provider: 'codex',
          dataTier: 'confidential',
          tenant_slug: slug,
          tenant_registry_root_dir: rootDir,
        }).allowed;
      // Default stays deny: no attestation, no confidential egress.
      expect(egress('beta')).toBe(false);

      const result = withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          slug: 'beta',
          provider: 'codex',
          training_use: 'none',
          plan: 'ChatGPT Enterprise',
          basis: 'https://openai.com/enterprise-privacy',
          attested_by: 'human:owner',
          rootDir,
        })
      );
      expect(result.attestation).toMatchObject({
        training_use: 'none',
        plan: 'ChatGPT Enterprise',
        attested_by: 'human:owner',
      });
      expect(result.profile_path).toContain(path.join('knowledge', 'personal', 'tenants'));
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.attest_provider',
          tenantSlug: 'beta',
          metadata: expect.objectContaining({ provider: 'codex', training_use: 'none' }),
        })
      );
      expect(egress('beta')).toBe(true);
      // The attestation belongs to beta: acme still cannot send to codex.
      expect(egress('acme')).toBe(false);
    } finally {
      record.mockRestore();
    }
  });

  it('rejects an attestation for a provider the egress policy does not declare', () => {
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          slug: 'acme',
          provider: 'not-a-provider',
          training_use: 'none',
          plan: 'x',
          basis: 'y',
          attested_by: 'z',
          rootDir,
        })
      )
    ).toThrow(/unknown provider 'not-a-provider'/);
    expect(
      withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir }))
        ?.provider_attestations?.['not-a-provider']
    ).toBeUndefined();
  });
});
