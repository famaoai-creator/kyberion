import { beforeEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({
  participants: [] as Array<{ actor: string; status: string; version: string }>,
  set: vi.fn(),
  remove: vi.fn(),
  issue: vi.fn(),
  lifecycle: vi.fn(),
  accountable: vi.fn(),
  list: vi.fn(),
  show: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, action: () => unknown) => action(),
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliOperatorIdentity: () => ({ principalId: 'user:owner' }),
}));
vi.mock('@agent/core/scope-context', () => ({
  resolveScopeContext: () => ({ tier: 'confidential', tenant_slug: 'acme' }),
}));
vi.mock('@agent/core/organization/organization-participants', () => ({
  listManagedOrganizations: async () => [],
  listOrganizationBusinessRoles: () => [
    { role_id: 'reviewer', name: 'Reviewer' },
    { role_id: 'implementer', name: 'Implementer' },
  ],
  listOrganizationParticipantCandidates: async () => [],
  listOrganizationParticipants: async () => s.participants,
  setOrganizationParticipant: s.set,
  removeOrganizationParticipant: s.remove,
}));
vi.mock('@agent/core/organization/organization-agent-management', () => ({
  listManagedOrganizationAgents: s.list,
  showManagedOrganizationAgent: s.show,
  issueManagedOrganizationAgent: s.issue,
  changeManagedOrganizationAgentLifecycle: s.lifecycle,
  reassignManagedOrganizationAgentAccountable: s.accountable,
}));
import { runOrganizationPeople } from './organization_people.js';
const version = 'a'.repeat(64);
const auth = {
  memberId: 'owner',
  actorId: 'user:owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all',
  allowedProjectIds: 'all',
};
describe('organization participant/agent CLI transport', () => {
  beforeEach(() => {
    s.participants = [];
    for (const key of [
      'set',
      'remove',
      'issue',
      'lifecycle',
      'accountable',
      'list',
      'show',
    ] as const)
      s[key].mockReset();
    s.list.mockResolvedValue([]);
    s.show.mockResolvedValue({
      nhi_id: 'kyberion://agent/org-a/helper',
      home_organization_id: 'org-a',
      version,
    });
  });
  it('keeps assignment mutation dry-run until --apply and forwards plural responsibilities', async () => {
    const args = [
      'assign',
      '--organization-id',
      'org-a',
      '--actor',
      'user:alice',
      '--role',
      'reviewer',
      '--role',
      'implementer',
    ];
    const print = vi.fn();
    await runOrganizationPeople('participant', args, print);
    expect(print).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dry-run', role_ids: ['reviewer', 'implementer'] })
    );
    expect(s.set).not.toHaveBeenCalled();
    await runOrganizationPeople('participant', [...args, '--apply'], print);
    expect(s.set).toHaveBeenCalledWith(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      roleIds: ['reviewer', 'implementer'],
      expectedVersion: undefined,
    });
  });
  it('requires and forwards the current assignment fence for set-roles/removal', async () => {
    s.participants = [{ actor: 'user:alice', status: 'active', version }];
    await expect(
      runOrganizationPeople(
        'participant',
        [
          'set-roles',
          '--organization-id',
          'org-a',
          '--actor',
          'user:alice',
          '--role',
          'reviewer',
          '--apply',
        ],
        vi.fn()
      )
    ).rejects.toThrow('--expected-version');
    await runOrganizationPeople(
      'participant',
      [
        'unassign',
        '--organization-id',
        'org-a',
        '--actor',
        'user:alice',
        '--expected-version',
        version,
        '--apply',
      ],
      vi.fn()
    );
    expect(s.remove).toHaveBeenCalledWith(auth, {
      organizationId: 'org-a',
      actor: 'user:alice',
      expectedVersion: version,
    });
  });
  it('rejects unknown roles before advertising a runnable dry-run', async () => {
    await expect(
      runOrganizationPeople(
        'participant',
        ['assign', '--organization-id', 'org-a', '--actor', 'user:alice', '--role', 'unknown'],
        vi.fn()
      )
    ).rejects.toThrow('registered responsibilities');
    expect(s.set).not.toHaveBeenCalled();
  });
  it('issues via the canonical agent facade only with --apply', async () => {
    const args = [
      'issue',
      '--organization-id',
      'org-a',
      '--slug',
      'helper',
      '--accountable-human',
      'user:owner',
    ];
    await runOrganizationPeople('agent', args, vi.fn());
    expect(s.issue).not.toHaveBeenCalled();
    await runOrganizationPeople('agent', [...args, '--apply'], vi.fn());
    expect(s.issue).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        organizationId: 'org-a',
        slug: 'helper',
        accountableHumanId: 'user:owner',
        kind: 'agent',
      })
    );
  });
  it('routes lifecycle and accountability changes with reviewed versions and reasons', async () => {
    await runOrganizationPeople(
      'agent',
      [
        'suspend',
        '--organization-id',
        'org-a',
        '--nhi-id',
        'kyberion://agent/org-a/helper',
        '--expected-version',
        version,
        '--reason',
        'Pause',
        '--apply',
      ],
      vi.fn()
    );
    expect(s.lifecycle).toHaveBeenCalledWith(auth, {
      nhiId: 'kyberion://agent/org-a/helper',
      expectedVersion: version,
      action: 'suspend',
      reason: 'Pause',
    });
    await runOrganizationPeople(
      'agent',
      [
        'reassign-accountable',
        '--nhi-id',
        'kyberion://agent/org-a/helper',
        '--expected-version',
        version,
        '--accountable-human',
        'user:alice',
        '--reason',
        'Handover',
        '--apply',
      ],
      vi.fn()
    );
    expect(s.accountable).toHaveBeenCalledWith(auth, {
      nhiId: 'kyberion://agent/org-a/helper',
      expectedVersion: version,
      accountableHumanId: 'user:alice',
      reason: 'Handover',
    });
  });
  it('respects explicit organization narrowing and rejects stale agent drafts before effects', async () => {
    await expect(
      runOrganizationPeople(
        'agent',
        [
          'suspend',
          '--organization-id',
          'org-b',
          '--nhi-id',
          'kyberion://agent/org-a/helper',
          '--expected-version',
          version,
          '--apply',
        ],
        vi.fn()
      )
    ).rejects.toThrow('selected authorized organization');
    await expect(
      runOrganizationPeople(
        'agent',
        [
          'suspend',
          '--nhi-id',
          'kyberion://agent/org-a/helper',
          '--expected-version',
          'b'.repeat(64),
          '--apply',
        ],
        vi.fn()
      )
    ).rejects.toThrow('agent changed');
    expect(s.lifecycle).not.toHaveBeenCalled();
  });
});
