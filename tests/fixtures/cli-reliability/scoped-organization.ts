/**
 * R01 fixture — synthetic confidential organization scope for lifecycle tests.
 *
 * Everything here is synthetic: no real tenant data, no real secrets. Sentinel
 * strings mark confidential payload boundaries so leak assertions can grep for
 * them in public/shared locations.
 */

import type { ScopeContext } from '../../../libs/core/scope-context-validation.js';
import type { SecretResolver } from '../../../libs/core/secret/secret-resolver.js';
import type { ScopeMintInput, ScopeEnvelope } from '../../../libs/core/scope-envelope.js';
import { mintScopeEnvelope } from '../../../libs/core/scope-envelope.js';

export const TENANT_A = 'fixture-tenant-a';
export const TENANT_B = 'fixture-tenant-b';
export const ORG_A = 'fixture-org-a';
export const PROJECT_A = 'PRJ-FIXTURE-RELIABILITY';

/** Sentinel body that must never appear on a public/shared floor or log. */
export const SENTINEL_CONFIDENTIAL_BODY = `confidential-sentinel-${process.pid}-do-not-leak`;

/** A synthetic confidential scope context — mirrors what intake produces. */
export function tenantAScopeContext(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    tier: 'confidential',
    tenant_slug: TENANT_A,
    organization_id: ORG_A,
    project_id: PROJECT_A,
    ...overrides,
  } as ScopeContext;
}

export function tenantBScopeContext(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    tier: 'confidential',
    tenant_slug: TENANT_B,
    organization_id: 'fixture-org-b',
    ...overrides,
  } as ScopeContext;
}

/**
 * Mint a confidential dispatch envelope for tenant A — the same shape the
 * coordinated execution port mints after owning a WorkItem claim.
 */
export function tenantAEnvelope(identityOverrides: Record<string, unknown> = {}): ScopeEnvelope {
  const input: ScopeMintInput = {
    identity: { ...tenantAScopeContext(), ...identityOverrides },
    policy: {
      purpose: 'fixture confidential lifecycle dispatch',
      read_tiers: ['confidential', 'public'],
      write_tier: 'confidential',
      external_egress: 'deny',
    },
  };
  return mintScopeEnvelope(input);
}

export function tenantBEnvelope(): ScopeEnvelope {
  return mintScopeEnvelope({
    identity: tenantBScopeContext(),
    policy: {
      purpose: 'fixture cross-tenant negative dispatch',
      read_tiers: ['confidential', 'public'],
      write_tier: 'confidential',
      external_egress: 'deny',
    },
  });
}

/**
 * Test-only secret resolver. resolve() returns nothing (no service creds);
 * bindTask() mints a synthetic binding stamped with the claimed scope so the
 * test can assert the binding carries the original tenant/mission/task.
 */
export function createFixtureSecretResolver(
  opts: { bindTenantSlug?: string } = {}
): SecretResolver {
  return {
    name: 'fixture-secret-resolver',
    resolve: () => null,
    describe: () => ({ name: 'fixture-secret-resolver', sources: ['fixture'] }),
    bindTask: (input) => ({
      tenantSlug: opts.bindTenantSlug ?? input.scope.tenant_slug ?? TENANT_A,
      missionId: input.scope.mission_id,
      taskId: input.scope.task_id,
      secrets: { FIXTURE_TOKEN: 'fixture-secret-value' },
    }),
  };
}

/**
 * Test-only resolver that intentionally binds the WRONG tenant — used by the
 * cross-tenant negative case to prove the binding mismatch is refused.
 */
export function createCrossTenantResolver(): SecretResolver {
  return {
    name: 'fixture-cross-tenant-resolver',
    resolve: () => null,
    bindTask: (input) => ({
      tenantSlug: input.scope.tenant_slug === TENANT_A ? TENANT_B : TENANT_A,
      secrets: { FIXTURE_TOKEN: 'fixture-secret-value' },
    }),
  };
}
