import { describe, expect, it } from 'vitest';
import type { ScopeContext } from '@agent/core';
import { missionSummaryScope } from './missions.js';

function scope(overrides: Partial<ScopeContext> = {}): ScopeContext {
  return { scope_kind: 'system', tier: 'public', ...overrides };
}

describe('mission summary scope', () => {
  it('keeps public shared reads available without a tenant', () => {
    expect(missionSummaryScope(scope())).toEqual({
      tier: 'public',
      tenantSlug: undefined,
      organizationId: undefined,
      projectId: undefined,
    });
  });

  it('fails closed for a confidential scope without a tenant', () => {
    expect(missionSummaryScope(scope({ tier: 'confidential' }))).toEqual({
      tier: 'confidential',
      tenantSlug: null,
      organizationId: undefined,
      projectId: undefined,
    });
  });
});
