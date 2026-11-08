import { describe, expect, it } from 'vitest';
import {
  padRecordVisible,
  scopeAdmits,
  type MinutesScope,
  type PadRecordLite,
} from './meeting-minutes';

/**
 * Pure visibility-rule tests — the same predicates the collectors apply per
 * record, exercised without fixture trees (collectors stay integration-level;
 * the scope matrix is where the security rules live).
 */

const baseScope = (overrides: Partial<MinutesScope> = {}): MinutesScope => ({
  tierAccess: ['public', 'confidential'],
  tenantSlugs: ['acme'],
  ...overrides,
});

describe('scopeAdmits', () => {
  it('admits an entry whose tier and tenant are both inside the scope', () => {
    expect(scopeAdmits(baseScope(), { tier: 'confidential', tenantSlug: 'acme' })).toBe(true);
  });

  it('rejects a tier the viewer cannot read', () => {
    expect(scopeAdmits(baseScope(), { tier: 'personal', tenantSlug: 'acme' })).toBe(false);
    expect(
      scopeAdmits(baseScope({ tierAccess: ['public'] }), {
        tier: 'confidential',
        tenantSlug: 'acme',
      })
    ).toBe(false);
  });

  it('admits every tenant only when the scope is all-tenants', () => {
    expect(
      scopeAdmits(baseScope({ tenantSlugs: 'all' }), { tier: 'public', tenantSlug: 'other' })
    ).toBe(true);
    expect(scopeAdmits(baseScope(), { tier: 'public', tenantSlug: 'other' })).toBe(false);
  });

  it('admits untenanted entries only when the scope explicitly includes them', () => {
    const entry = { tier: 'public' as const };
    expect(scopeAdmits(baseScope({ includeUntenanted: true }), entry)).toBe(true);
    expect(scopeAdmits(baseScope(), entry)).toBe(false);
    // 'all' tenants covers untenanted too — the tenant check short-circuits.
    expect(scopeAdmits(baseScope({ tenantSlugs: 'all' }), entry)).toBe(true);
  });
});

const padRecord = (overrides: Partial<PadRecordLite> = {}): PadRecordLite => ({
  record_id: 'rec-1',
  pad_id: 'meeting-notepad',
  title: 'Standup',
  body: '…',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  viewer_principal: 'operator-a',
  tier: 'confidential',
  // Default tenant so each assertion below isolates one dimension — the
  // tenant check would otherwise mask it (records without a tenant are only
  // admitted under includeUntenanted or 'all').
  scope: { tenant_slug: 'acme' },
  ...overrides,
});

describe('padRecordVisible', () => {
  it('hides personal-tier records from anyone but their own principal', () => {
    const record = padRecord({ tier: 'personal', viewer_principal: 'operator-a' });
    // Tier access already allows 'personal' in all three scopes — the
    // principal match is the deciding check.
    const allowed = baseScope({ tierAccess: ['personal'], viewerPrincipal: 'operator-a' });
    expect(padRecordVisible(record, allowed)).toBe(true);
    const wrongPrincipal = baseScope({ tierAccess: ['personal'], viewerPrincipal: 'operator-b' });
    expect(padRecordVisible(record, wrongPrincipal)).toBe(false);
    // A missing viewer principal can never match.
    expect(padRecordVisible(record, baseScope({ tierAccess: ['personal'] }))).toBe(false);
  });

  it('applies the tenant scope like the list index does', () => {
    const record = padRecord({ scope: { tenant_slug: 'other' } });
    expect(padRecordVisible(record, baseScope())).toBe(false);
    expect(padRecordVisible(record, baseScope({ tenantSlugs: 'all' }))).toBe(true);
  });

  it('narrows by organization only when the record declares one', () => {
    const scoped = padRecord({ scope: { tenant_slug: 'acme', organization_id: 'org-1' } });
    expect(padRecordVisible(scoped, baseScope({ organizationIds: ['org-1'] }))).toBe(true);
    expect(padRecordVisible(scoped, baseScope({ organizationIds: ['org-2'] }))).toBe(false);
    // A record with no organization stays visible under an org-narrowed scope.
    const unscoped = padRecord({ scope: { tenant_slug: 'acme' } });
    expect(padRecordVisible(unscoped, baseScope({ organizationIds: ['org-2'] }))).toBe(true);
    // 'all' never narrows.
    expect(padRecordVisible(scoped, baseScope({ organizationIds: 'all' }))).toBe(true);
  });

  it('narrows by project the same way', () => {
    const record = padRecord({ scope: { tenant_slug: 'acme', project_id: 'proj-1' } });
    expect(padRecordVisible(record, baseScope({ projectIds: ['proj-2'] }))).toBe(false);
    expect(padRecordVisible(record, baseScope({ projectIds: ['proj-1'] }))).toBe(true);
  });
});
