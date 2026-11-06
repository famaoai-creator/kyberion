import { describe, expect, it } from 'vitest';
import {
  CustodyOwnerConflictError,
  custodyOwnerLabel,
  deriveCustodyOwner,
} from './custody-owner.js';

describe('deriveCustodyOwner', () => {
  it('derives tenant / person / system from the scope when nothing is declared', () => {
    expect(deriveCustodyOwner({ tier: 'confidential', tenant_slug: 'acme' })).toEqual({
      kind: 'tenant',
      tenant_slug: 'acme',
    });
    expect(deriveCustodyOwner({ tier: 'personal', tenant_slug: 'acme' })).toEqual({
      kind: 'tenant',
      tenant_slug: 'acme',
    });
    expect(deriveCustodyOwner({ tier: 'personal' })).toEqual({ kind: 'person' });
    expect(deriveCustodyOwner({ tier: 'confidential' })).toEqual({ kind: 'system' });
    expect(deriveCustodyOwner({ tier: 'public' })).toEqual({ kind: 'system' });
  });

  it('accepts a declaration that restates the scope', () => {
    expect(
      deriveCustodyOwner({
        tier: 'confidential',
        tenant_slug: 'acme',
        custody: { kind: 'tenant', tenant_slug: 'acme' },
      })
    ).toEqual({ kind: 'tenant', tenant_slug: 'acme' });
    expect(
      deriveCustodyOwner({
        tier: 'confidential',
        custody: { kind: 'person', principal_id: 'alice' },
      })
    ).toEqual({ kind: 'person', principal_id: 'alice' });
    expect(deriveCustodyOwner({ tier: 'confidential', custody: { kind: 'system' } })).toEqual({
      kind: 'system',
    });
  });

  it.each([
    [
      'tenant custody without a tenant_slug',
      { tier: 'confidential' as const, custody: { kind: 'tenant' as const, tenant_slug: 'acme' } },
    ],
    [
      'tenant custody naming another tenant',
      {
        tier: 'confidential' as const,
        tenant_slug: 'acme',
        custody: { kind: 'tenant' as const, tenant_slug: 'other' },
      },
    ],
    [
      'system custody on tenant material',
      { tier: 'confidential' as const, tenant_slug: 'acme', custody: { kind: 'system' as const } },
    ],
    [
      'person custody on tenant material',
      { tier: 'personal' as const, tenant_slug: 'acme', custody: { kind: 'person' as const } },
    ],
    [
      'system custody on personal material',
      { tier: 'personal' as const, custody: { kind: 'system' as const } },
    ],
    ['an unknown kind', { tier: 'confidential' as const, custody: { kind: 'galaxy' } as never }],
    [
      'an invalid principal id',
      { tier: 'personal' as const, custody: { kind: 'person' as const, principal_id: '../x' } },
    ],
    [
      'a reserved tier name used as a tenant',
      { tier: 'confidential' as const, tenant_slug: 'personal' },
    ],
  ])('fails closed on %s', (_label, input) => {
    expect(() => deriveCustodyOwner(input)).toThrow(CustodyOwnerConflictError);
    expect(() => deriveCustodyOwner(input)).toThrow(/\[CUSTODY_OWNER_CONFLICT\]/);
  });

  it('labels owners for logs and evidence', () => {
    expect(custodyOwnerLabel({ kind: 'system' })).toBe('system');
    expect(custodyOwnerLabel({ kind: 'tenant', tenant_slug: 'acme' })).toBe('tenant:acme');
    expect(custodyOwnerLabel({ kind: 'person' })).toBe('person');
    expect(custodyOwnerLabel({ kind: 'person', principal_id: 'alice' })).toBe('person:alice');
  });
});
