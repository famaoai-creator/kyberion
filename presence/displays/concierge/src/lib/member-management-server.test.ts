import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConciergeViewerContext } from './viewer-context';
const s = vi.hoisted(() => ({ memberId: 'owner', active: true }));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, action: () => unknown) => action(),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: () => (s.active ? { member_id: s.memberId, status: 'active' } : null),
}));
import {
  assertMemberManagementContext,
  memberManagementContextId,
  memberManagementPrincipal,
} from './member-management-server';
function viewer(): ConciergeViewerContext {
  return {
    source: 'loopback',
    role: 'localadmin',
    tenantSlugs: ['beta', 'acme'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'personal'],
    principalId: 'local-owner',
  };
}
describe('server member identity context fence', () => {
  beforeEach(() => {
    s.memberId = 'owner';
    s.active = true;
  });
  it('normalizes grant ordering and does not depend on the selected company', () => {
    const full = viewer();
    const hash = memberManagementContextId(full);
    expect(
      memberManagementContextId({
        ...full,
        tenantSlugs: ['acme', 'beta'],
        tierAccess: ['personal', 'confidential'],
      })
    ).toBe(hash);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertMemberManagementContext(full, hash)).not.toThrow();
  });
  it('changes with the canonical owner identity or effective grant set', () => {
    const full = viewer();
    const before = memberManagementContextId(full);
    s.memberId = 'alice';
    expect(memberManagementContextId(full)).not.toBe(before);
    expect(() => assertMemberManagementContext(full, before)).toThrow('identity or access changed');
    s.memberId = 'owner';
    expect(memberManagementContextId({ ...full, tenantSlugs: ['acme'] })).not.toBe(before);
  });
  it('rejects inactive and mismatched authenticated members', () => {
    s.active = false;
    expect(() => memberManagementPrincipal(viewer())).toThrow('active registered');
    s.active = true;
    const full = viewer();
    full.principal = {
      actor: { kind: 'human', id: 'user:other' },
      memberId: 'other',
      tenantSlugs: 'all',
    } as ConciergeViewerContext['principal'];
    expect(() => memberManagementPrincipal(full)).toThrow('binding changed');
  });
  it('retains compatibility only when no fence was supplied', () => {
    expect(() => assertMemberManagementContext(viewer(), undefined)).not.toThrow();
    expect(() => assertMemberManagementContext(viewer(), 'not-a-context')).toThrow(
      'Refresh the member list'
    );
  });
});
