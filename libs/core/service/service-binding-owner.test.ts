import { describe, expect, it } from 'vitest';
import {
  isBindingVisibleTo,
  resolveBindingOwner,
  validateBindingOwner,
} from './service-binding-owner.js';

describe('resolveBindingOwner', () => {
  it('uses the declared owner as-is', () => {
    expect(resolveBindingOwner({ owner_kind: 'person', owner_ref: 'user:alice' })).toEqual({
      owner_kind: 'person',
      owner_ref: 'user:alice',
      derived: false,
    });
  });
  it('derives organization from tenant_slug and person otherwise — never operator', () => {
    expect(resolveBindingOwner({ tenant_slug: 'acme' })).toEqual({
      owner_kind: 'organization',
      owner_ref: 'acme',
      derived: true,
    });
    expect(resolveBindingOwner({})).toEqual({ owner_kind: 'person', derived: true });
  });
});

describe('validateBindingOwner', () => {
  it('accepts coherent owners', () => {
    expect(validateBindingOwner({ tenant_slug: 'acme' })).toEqual([]);
    expect(validateBindingOwner({})).toEqual([]);
    expect(validateBindingOwner({ owner_kind: 'person', owner_ref: 'user:alice' })).toEqual([]);
    expect(
      validateBindingOwner({ owner_kind: 'organization', owner_ref: 'acme', tenant_slug: 'acme' })
    ).toEqual([]);
    expect(validateBindingOwner({ owner_kind: 'operator' })).toEqual([]);
  });
  it('rejects a person connection that carries a tenant (cross-tenant leak) or lacks a member ref', () => {
    expect(
      validateBindingOwner({ owner_kind: 'person', owner_ref: 'user:alice', tenant_slug: 'acme' })
    ).toEqual([expect.stringMatching(/must not carry tenant_slug/)]);
    expect(validateBindingOwner({ owner_kind: 'person' })).toEqual([
      expect.stringMatching(/user:<member_id>/),
    ]);
  });
  it('rejects an organization connection without or with a different tenant, and a tenanted operator one', () => {
    expect(validateBindingOwner({ owner_kind: 'organization', owner_ref: 'acme' })).toEqual([
      expect.stringMatching(/needs tenant_slug/),
    ]);
    expect(
      validateBindingOwner({ owner_kind: 'organization', owner_ref: 'beta', tenant_slug: 'acme' })
    ).toEqual([expect.stringMatching(/must equal tenant_slug/)]);
    expect(validateBindingOwner({ owner_kind: 'operator', tenant_slug: 'acme' })).toEqual([
      expect.stringMatching(/must not carry tenant_slug/),
    ]);
  });
});

describe('isBindingVisibleTo', () => {
  const viewer = { memberId: 'alice', tenantSlugs: ['acme'] as const };
  it('person connections are visible to their owner only', () => {
    const mine = { owner_kind: 'person' as const, owner_ref: 'user:alice' };
    expect(isBindingVisibleTo(mine, viewer)).toBe(true);
    expect(isBindingVisibleTo(mine, { memberId: 'bob', tenantSlugs: ['acme'] })).toBe(false);
    expect(isBindingVisibleTo(mine, { tenantSlugs: 'all' })).toBe(false);
  });
  it('organization connections follow the server-resolved tenant set', () => {
    expect(isBindingVisibleTo({ tenant_slug: 'acme' }, viewer)).toBe(true);
    expect(isBindingVisibleTo({ tenant_slug: 'beta' }, viewer)).toBe(false);
    expect(isBindingVisibleTo({ tenant_slug: 'beta' }, { tenantSlugs: 'all' })).toBe(true);
  });
  it('operator connections are never on day-to-day surfaces', () => {
    expect(isBindingVisibleTo({ owner_kind: 'operator' }, { tenantSlugs: 'all' })).toBe(false);
  });
});
