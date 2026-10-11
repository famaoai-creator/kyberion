import { describe, expect, it } from 'vitest';
import { isValidChronosScopeId, isValidMemberId, isValidTenantSlug } from './scope.js';
import { isValidChronosScopeId as legacyScopeId } from '../chronos-access-registry.js';
import { isValidMemberId as legacyMemberId } from '../organization/member-id-grammar.js';

describe('pure scope grammar compatibility', () => {
  it('keeps the existing domain import paths as the same validators', () => {
    expect(legacyScopeId).toBe(isValidChronosScopeId);
    expect(legacyMemberId).toBe(isValidMemberId);
  });

  it.each([
    ['alice', true, true, true],
    ['ext-alice', true, true, true],
    ['public', true, false, true],
    ['confidential', true, false, true],
    ['personal', true, false, true],
    ['shared', true, false, true],
    ['a', false, false, true],
    ['a'.repeat(31), true, true, true],
    ['a'.repeat(32), false, false, true],
    ['', false, false, false],
    [' Alice', false, false, false],
    ['alice ', false, false, false],
    ['alice/bob', false, false, false],
    ['alice\tbob', false, false, false],
    ['alice\nbob', false, false, false],
    ['alice\n', false, false, false],
    ['org:one', false, false, true],
    ['組織', false, false, true],
  ])('preserves member/tenant/scope rules for %j', (value, member, tenant, scope) => {
    expect(isValidMemberId(value)).toBe(member);
    expect(isValidTenantSlug(value)).toBe(tenant);
    expect(isValidChronosScopeId(value)).toBe(scope);
  });

  it.each([null, undefined, 123, {}, []])('retains the scope string check for %j', (value) => {
    expect(isValidChronosScopeId(value as string)).toBe(false);
  });
});
