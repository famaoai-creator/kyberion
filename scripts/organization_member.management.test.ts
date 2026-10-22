import { beforeEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), list: vi.fn() }));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, action: () => unknown) => action(),
}));
vi.mock('@agent/core/governance', () => ({
  withExecutionContext: (_role: string, action: () => unknown) => action(),
}));
vi.mock('@agent/core/governance/audit-chain', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliOperatorIdentity: () => ({ principalId: 'user:owner' }),
}));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeContext: () => ({ tenant_slug: 'acme' }),
}));
vi.mock('@agent/core/organization/member-management', () => ({
  createManagedMember: s.create,
  updateManagedMember: s.update,
  listManagedMembers: s.list,
}));
import { parseMemberCommand, runOrganizationMember } from './organization_member.js';
describe('managed member CLI parity', () => {
  beforeEach(() => {
    s.create.mockReset();
    s.update.mockReset();
    s.list.mockReset();
    s.list.mockResolvedValue([
      {
        member_id: 'alice',
        version: 'reviewed',
        memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
      },
    ]);
  });
  it('parses new governed verbs without changing identity-link command parsing', () => {
    expect(
      parseMemberCommand(['grant', 'alice', '--tenant', 'acme', '--role', 'approver', '--apply'])
    ).toMatchObject({
      kind: 'managed',
      action: 'grant',
      memberId: 'alice',
      tenantSlug: 'acme',
      role: 'approver',
      apply: true,
    });
    expect(() => parseMemberCommand(['update', 'alice', '--unexpected', 'x'])).toThrow(
      'unknown member option'
    );
  });
  it('lists/shows the tenant-scoped shared projection', async () => {
    const print = vi.fn();
    await runOrganizationMember(['show', 'alice', '--tenant', 'acme'], print);
    expect(s.list).toHaveBeenCalledWith({ memberId: 'owner', allowedTenantSlugs: 'all' }, 'acme');
    expect(JSON.parse(print.mock.calls[0][0]).version).toBe('reviewed');
  });
  it('keeps new mutations dry-run until --apply and uses shared human creation', async () => {
    const args = ['create', 'alice', '--name', 'Alice', '--tenant', 'acme', '--role', 'viewer'];
    await runOrganizationMember(args, vi.fn());
    expect(s.create).not.toHaveBeenCalled();
    await runOrganizationMember([...args, '--apply'], vi.fn());
    expect(s.create).toHaveBeenCalledWith(
      { memberId: 'owner', allowedTenantSlugs: 'all' },
      { memberId: 'alice', displayName: 'Alice', tenantSlug: 'acme', role: 'viewer' }
    );
  });
  it('routes rename, membership removal and suspend through one shared core rule', async () => {
    await runOrganizationMember(
      ['update', 'alice', '--name', 'Alice human', '--expected-version', 'reviewed', '--apply'],
      vi.fn()
    );
    expect(s.update).toHaveBeenLastCalledWith(
      { memberId: 'owner', allowedTenantSlugs: 'all' },
      { memberId: 'alice', displayName: 'Alice human', expectedVersion: 'reviewed' }
    );
    await runOrganizationMember(['revoke', 'alice', '--tenant', 'acme', '--apply'], vi.fn());
    expect(s.update).toHaveBeenLastCalledWith(expect.anything(), {
      memberId: 'alice',
      removeTenantSlug: 'acme',
      expectedVersion: undefined,
    });
    await runOrganizationMember(['suspend', 'alice', '--apply'], vi.fn());
    expect(s.update).toHaveBeenLastCalledWith(expect.anything(), {
      memberId: 'alice',
      status: 'suspended',
      expectedVersion: undefined,
    });
  });
});
