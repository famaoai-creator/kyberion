import { describe, expect, it } from 'vitest';
import {
  customerDecisionInviteWriteDenial,
  isRegisteredActiveTenantProfile,
  isRevokeOnlyInviteChange,
} from './customer-decision-invite-write-content.js';
import {
  caseRecordCanonicalJson,
  customerDecisionMilestoneWriteProblem,
} from './customer-decision-milestone-capability.js';

const TENANT = 'acme';
const RECORD =
  'active/shared/runtime/customer-decision-invites/confidential/acme/inv-00000000000000aa.json';
const previous = {
  version: '1.0.0',
  invite_id: 'inv-00000000000000aa',
  tenant_slug: TENANT,
  expires_at: '2026-11-01T00:00:00.000Z',
  uses: [],
};
const revoked = { ...previous, revoked_at: '2026-10-25T00:00:00.000Z', revoked_reason: 'done' };

function reader(files: Record<string, string>) {
  return (relative: string) => files[relative];
}

describe('customer decision invite write content (CD-10)', () => {
  it('reads the registry profile raw and requires a matching active profile', () => {
    const profile = (value: unknown) =>
      reader({ [`knowledge/personal/tenants/${TENANT}.json`]: JSON.stringify(value) });
    expect(
      isRegisteredActiveTenantProfile(TENANT, profile({ tenant_slug: TENANT, status: 'active' }))
    ).toBe(true);
    expect(
      isRegisteredActiveTenantProfile(TENANT, profile({ tenant_slug: TENANT, status: 'suspended' }))
    ).toBe(false);
    expect(
      isRegisteredActiveTenantProfile(TENANT, profile({ tenant_slug: 'other', status: 'active' }))
    ).toBe(false);
    expect(isRegisteredActiveTenantProfile(TENANT, reader({}))).toBe(false);
    expect(
      isRegisteredActiveTenantProfile(
        TENANT,
        reader({ [`knowledge/personal/tenants/${TENANT}.json`]: '{' })
      )
    ).toBe(false);
  });

  it('accepts only a revoke added to an unrevoked record', () => {
    expect(isRevokeOnlyInviteChange(previous, revoked)).toBe(true);
    expect(isRevokeOnlyInviteChange(previous, { ...revoked, expires_at: '2099-01-01' })).toBe(
      false
    );
    expect(isRevokeOnlyInviteChange(undefined, revoked)).toBe(false);
    expect(isRevokeOnlyInviteChange(revoked, { ...revoked, revoked_reason: 'again' })).toBe(false);
    expect(isRevokeOnlyInviteChange(previous, { ...previous, revoked_at: '' })).toBe(false);
  });

  it('a "__proto__" key in the new content never drops out of the comparison', () => {
    const smuggled = JSON.parse(
      JSON.stringify(revoked).replace(/^\{/u, '{"__proto__":{"uses":[{"at":"x"}]},')
    ) as Record<string, unknown>;
    expect(Object.keys(smuggled)).toContain('__proto__');
    expect(isRevokeOnlyInviteChange(previous, smuggled)).toBe(false);
    const primitive = JSON.parse(
      JSON.stringify(revoked).replace(/^\{/u, '{"__proto__":1,')
    ) as Record<string, unknown>;
    expect(isRevokeOnlyInviteChange(previous, primitive)).toBe(false);
    expect(caseRecordCanonicalJson(JSON.parse('{"__proto__":1,"a":2}'))).toBe(
      '{"__proto__":1,"a":2}'
    );
    expect(caseRecordCanonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"b":1}'
    );
  });

  it('the milestone rule also sees a "__proto__" key', () => {
    const agenda = { agenda_id: 'agd-x', title: 'T', milestones_passed: [] };
    const next = JSON.parse(
      JSON.stringify({ ...agenda, milestones_passed: ['bolt-after:M'] }).replace(
        /^\{/u,
        '{"__proto__":{"title":"other"},'
      )
    ) as unknown;
    expect(customerDecisionMilestoneWriteProblem(agenda, next)).toMatch(
      /CUSTOMER_DECISION_MILESTONE_WRITE_REFUSED/u
    );
    expect(
      customerDecisionMilestoneWriteProblem(agenda, { ...agenda, milestones_passed: ['m'] })
    ).toBeNull();
  });

  it('refuses every write and mkdir of an inactive tenant except a revoke', () => {
    const files = { [RECORD]: JSON.stringify(previous) };
    const deny = (operation: 'write' | 'mkdir', content?: string, relativePath = RECORD) =>
      customerDecisionInviteWriteDenial({
        tenantSlug: TENANT,
        relativePath,
        operation,
        content,
        readRepoFile: reader(files),
      });
    expect(deny('write', JSON.stringify(revoked))).toBeNull();
    expect(deny('write', JSON.stringify({ ...previous, uses: [{ at: 'x' }] }))).toMatch(
      /CD_INVITE_TENANT_NOT_REGISTERED/u
    );
    expect(deny('write')).toMatch(/CD_INVITE_TENANT_NOT_REGISTERED/u);
    expect(deny('mkdir')).toMatch(/CD_INVITE_TENANT_NOT_REGISTERED/u);
    // A brand-new record (nothing on disk) is not a revoke.
    expect(deny('write', JSON.stringify(revoked), RECORD.replace('aa.json', 'bb.json'))).toMatch(
      /CD_INVITE_TENANT_NOT_REGISTERED/u
    );
    // Reads are not this rule's concern; an active tenant passes.
    expect(
      customerDecisionInviteWriteDenial({
        tenantSlug: TENANT,
        relativePath: RECORD,
        operation: 'read',
        content: undefined,
        readRepoFile: reader(files),
      })
    ).toBeNull();
    expect(
      customerDecisionInviteWriteDenial({
        tenantSlug: TENANT,
        relativePath: RECORD,
        operation: 'mkdir',
        content: undefined,
        readRepoFile: reader({
          [`knowledge/personal/tenants/${TENANT}.json`]: JSON.stringify({
            tenant_slug: TENANT,
            status: 'active',
          }),
        }),
      })
    ).toBeNull();
  });
});
