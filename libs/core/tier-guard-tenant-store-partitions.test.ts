import { describe, expect, it } from 'vitest';
import {
  tenantScopeConfig,
  normalizeRegisteredTenantProfile,
  isValidTenantGroupProfile,
  extractTenantGroupFromSharedPath,
} from './tier-guard-tenant-store-partitions.js';

describe('tenant store policy normalization', () => {
  it('keeps default registry roles, broker requirements and caller-resolved tenant binding', () => {
    const config = tenantScopeConfig({}, false);
    expect(config.protectedPrefixes).toEqual(['knowledge/confidential/']);
    expect(config.systemRegistryReads).toEqual([
      {
        path: 'knowledge/confidential/tenants/index.json',
        roles: ['check_tenant_registry_consistency'],
      },
    ]);
    expect(config.brokerRequirements).toEqual({
      requireApprovedBy: true,
      requireApprovedAt: true,
      requireExpiresAt: true,
    });
    expect(config.requireTenantBinding).toBe(false);
    expect(tenantScopeConfig({}, true).requireTenantBinding).toBe(true);
    expect(
      tenantScopeConfig({ tenant_scope: { require_tenant_binding: true } }, false)
        .requireTenantBinding
    ).toBe(true);
  });

  it('keeps custom protected/shared roots and filters malformed registry read declarations', () => {
    const config = tenantScopeConfig(
      {
        tenant_scope: {
          protected_prefixes: ['active/custom/confidential/'],
          shared_prefixes: [],
          slug_pattern: '[',
          system_registry_reads: [
            null,
            { path: 'registry.json', roles: ['owned_reader'] },
            { path: 'wrong', roles: [1] },
          ],
          broker_requirements: {
            require_approved_by: false,
            require_approved_at: true,
            require_expires_at: false,
          },
        },
      },
      false
    );
    expect(config.protectedPrefixes).toEqual(['active/custom/confidential/']);
    expect(config.sharedPrefixes).toEqual([]);
    expect(config.systemRegistryReads).toEqual([
      { path: 'registry.json', roles: ['owned_reader'] },
    ]);
    expect(config.slugPattern.test('tenant-valid')).toBe(true);
    expect(config.slugPattern.test('../tenant')).toBe(false);
    expect(config.brokerRequirements).toEqual({
      requireApprovedBy: false,
      requireApprovedAt: true,
      requireExpiresAt: false,
    });
  });

  it('retains profile shape normalization without treating suspended status as active', () => {
    expect(
      normalizeRegisteredTenantProfile({
        tenant_slug: 'tenant-a',
        status: 'suspended',
        extra: true,
      })
    ).toEqual({ tenant_slug: 'tenant-a', status: 'suspended' });
    for (const value of [
      null,
      [],
      { tenant_slug: 'tenant-a' },
      { tenant_slug: 5, status: 'active' },
    ])
      expect(normalizeRegisteredTenantProfile(value)).toBeNull();
  });

  it('requires tenant group members and shared prefixes to belong to the exact group', () => {
    expect(extractTenantGroupFromSharedPath('knowledge/confidential/shared/group-a/notes')).toBe(
      'group-a'
    );
    expect(extractTenantGroupFromSharedPath('knowledge/confidential/tenant-a/notes')).toBeNull();
    const profile = {
      tenant_group_id: 'group-a',
      status: 'active',
      member_tenants: ['tenant-a'],
      shared_prefixes: ['knowledge/confidential/shared/group-a/notes/'],
    };
    expect(isValidTenantGroupProfile('group-a', profile)).toBe(true);
    for (const changed of [
      { ...profile, tenant_group_id: 'group-b' },
      { ...profile, status: 'unknown' },
      { ...profile, member_tenants: [] },
      { ...profile, member_tenants: ['../tenant'] },
      { ...profile, shared_prefixes: [] },
      { ...profile, shared_prefixes: ['knowledge/confidential/shared/group-b/'] },
    ])
      expect(isValidTenantGroupProfile('group-a', changed)).toBe(false);
  });
});
