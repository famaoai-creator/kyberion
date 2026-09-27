import { describe, expect, it } from 'vitest';
import { assertMemoryScope, memoryScopeAllowsRead } from './memory-scope.js';

describe('memory scope', () => {
  const tenantScope = {
    tier: 'confidential' as const,
    tenant_slug: 'acme-corp',
    organization_id: 'org-a',
    mission_id: 'MSN-1',
    owner_nhi: 'kyberion://agent/org-a/planner',
  };

  it('requires tenant scope for confidential memory', () => {
    expect(() => assertMemoryScope({ tier: 'confidential' })).toThrow('[SCOPE_CONTEXT_INVALID]');
  });

  it('allows only same tenant and compatible ancestors to read', () => {
    expect(
      memoryScopeAllowsRead(tenantScope, {
        ...tenantScope,
        task_id: 'TASK-1',
        nhi_id: tenantScope.owner_nhi,
      })
    ).toBe(true);
    expect(memoryScopeAllowsRead(tenantScope, { ...tenantScope, tenant_slug: 'beta-corp' })).toBe(
      false
    );
    expect(memoryScopeAllowsRead({ tier: 'public' }, { ...tenantScope })).toBe(true);
    expect(
      memoryScopeAllowsRead(
        { tier: 'public', tenant_slug: 'acme-corp' },
        { tier: 'public', tenant_slug: 'beta-corp' }
      )
    ).toBe(true);
    expect(
      memoryScopeAllowsRead(
        { tier: 'public', allowed_audience: ['nhi:allowed'] },
        { tier: 'public', nhi_id: 'nhi:other' }
      )
    ).toBe(false);
  });

  it('denies a lower-tier viewer and an audience-mismatched principal', () => {
    expect(
      memoryScopeAllowsRead(tenantScope, {
        ...tenantScope,
        tier: 'public',
        nhi_id: tenantScope.owner_nhi,
      })
    ).toBe(false);
    expect(
      memoryScopeAllowsRead(
        { ...tenantScope, allowed_audience: ['nhi:allowed'] },
        { ...tenantScope, nhi_id: 'nhi:other', viewer_principal: 'nhi:other' }
      )
    ).toBe(false);
  });

  it('requires the owner or an explicit audience for unscoped personal memory', () => {
    const source = {
      tier: 'personal' as const,
      owner_nhi: 'nhi:owner',
    };
    expect(memoryScopeAllowsRead(source, { tier: 'personal', nhi_id: 'nhi:owner' })).toBe(true);
    expect(memoryScopeAllowsRead(source, { tier: 'personal', nhi_id: 'nhi:other' })).toBe(false);
  });
});
