import { describe, expect, it } from 'vitest';
import { operatorHomeScopeFilter } from './operator-home.js';
import type { ScopeContext } from '@agent/core';

function scope(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return {
    scope_kind: 'system',
    tier: 'public',
    ...overrides,
  };
}

describe('operator home scope filter', () => {
  it('keeps tenant-scoped cockpit reads inside the active tenant', () => {
    expect(
      operatorHomeScopeFilter(
        scope({
          scope_kind: 'tenant',
          tier: 'confidential',
          tenant_slug: 'tenant-a',
          organization_id: 'org-a',
          project_id: 'project-a',
        })
      )
    ).toEqual({
      tiers: ['confidential'],
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
    });
  });

  it('fails closed for non-public scopes without a tenant binding', () => {
    expect(operatorHomeScopeFilter(scope({ tier: 'confidential' }))).toEqual({
      tiers: ['confidential'],
      tenantSlugs: [],
    });

    expect(operatorHomeScopeFilter(scope({ tier: 'public' }))).toEqual({
      tiers: ['public'],
      tenantSlugs: 'all',
    });
  });
});
