import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { mutateTenant } from './tenant-governance.js';
import { readTenantProfile, recordTenantProviderAttestation } from './tenant-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

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
});
