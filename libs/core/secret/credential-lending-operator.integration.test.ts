/**
 * Tenant-custody lending as the resident Dot runtime binds it (final review 1):
 * organization_operator inside credential_allocation_reader, with the REAL owner
 * check (grant-store verifyGrantBasis → credentialLendingApprovedByOwner →
 * isTenantOwnerMember → member_owner_reader) and the REAL tier-guard deciding the
 * member-profile read. Hermetic: grants, the approval record, member profiles,
 * connection files and audit are fixtures — the member read is served from a
 * fixture only after tier-guard allows it for the live identity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { validateReadPermission } from '../tier-guard.js';
import type { GrantRecord } from '../governance/grant-store.js';
import {
  buildCredentialRecord,
  credentialConnectionPath,
  credentialRecordPath,
  lendingFromRecord,
  parseCredentialRef,
} from './credential-custody.js';

const state = vi.hoisted(() => ({
  grants: [] as GrantRecord[],
  approval: undefined as Record<string, unknown> | undefined,
  files: {} as Record<string, Record<string, unknown>>,
  memberReads: [] as Array<{ member: string; allowed: boolean }>,
}));
const MEMBERS: Record<string, { tenant_slug: string; role: string }[]> = {
  cfo: [{ tenant_slug: 'parent', role: 'owner' }],
  mallory: [{ tenant_slug: 'parent', role: 'viewer' }],
};
vi.mock('../governance/grant-store.js', async (original) => ({
  ...(await original<typeof import('../governance/grant-store.js')>()),
  listGrants: () => state.grants,
  loadGrant: (_tenant: string, id: string) => state.grants.find((g) => g.grant_id === id) ?? null,
}));
vi.mock('../governance/approval-store-reader.js', async (original) => ({
  ...(await original<typeof import('../governance/approval-store-reader.js')>()),
  loadApprovalRequest: (_channel: string, id: string) =>
    id === 'APR-LEND' ? state.approval : undefined,
}));
// The human-decision format check has its own tests; the OWNER rule stays real.
vi.mock('../governance/service-credential-grant-scope.js', async (original) => ({
  ...(await original<typeof import('../governance/service-credential-grant-scope.js')>()),
  serviceAllocationApprovedByOwner: (
    approval: { workflow: { approvals: { approvedBy: string }[] } },
    owner: string
  ) => approval.workflow.approvals[0]!.approvedBy === owner,
}));
vi.mock('../organization/member-registry.js', async (original) => {
  const actual = await original<typeof import('../organization/member-registry.js')>();
  return {
    ...actual,
    readMemberProfile: (memberId: string) => {
      const file = pathResolver.rootResolve(`knowledge/personal/members/${memberId}.json`);
      const allowed = validateReadPermission(file).allowed;
      state.memberReads.push({ member: memberId, allowed });
      if (!allowed) throw new Error('[ROLE_VIOLATION] member profile read denied');
      return MEMBERS[memberId]
        ? { member_id: memberId, status: 'active', memberships: MEMBERS[memberId] }
        : null;
    },
  };
});
vi.mock('./shell-task-credential-binding.js', () => ({
  assertTaskCredentialClaim: () => 'claim-a',
}));
vi.mock('../governance/audit-chain.js', async (original) => {
  const actual = await original<typeof import('../governance/audit-chain.js')>();
  const record = () => ({ id: 'audit' });
  return { ...actual, auditChain: { ...actual.auditChain, record, recordDurable: record } };
});
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeMkdir: () => undefined,
}));
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJson: (file: string) => {
      const normalized = file.replaceAll('\\', '/');
      const key = Object.keys(state.files).find((suffix) => normalized.endsWith(suffix));
      return key ? state.files[key] : actual.readJson(file);
    },
  };
});
import {
  grantApprovalEffectBinding,
  grantApprovalPayload,
  normalizeGrantDraft,
} from '../governance/grant-store.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import {
  bindAllocatedTaskCredentials,
  setCredentialLendingDepsForTests,
} from './credential-allocations.js';

const GRANTED_AT = new Date(Date.now() - 3600_000).toISOString();
function lend(approver: string): void {
  const ref = parseCredentialRef('tenant:parent:anthropic');
  const record = buildCredentialRecord({
    credentialRef: 'tenant:parent:anthropic',
    value: 'sk-ant-parent-key-0001',
    registeredBy: 'user:cfo',
  });
  state.files = {
    [credentialConnectionPath(ref)]: { api_key: 'sk-ant-parent-key-0001' },
    [credentialRecordPath(ref)]: { ...record },
  };
  const draft = normalizeGrantDraft({
    capability: 'credential.use',
    tenant_slug: 'child',
    credential_provider: 'anthropic',
    credential_ref: 'anthropic/API_KEY',
    credential_lending: lendingFromRecord(record),
    purpose: 'subsidiary dot',
    ttl_days: 30,
  });
  state.grants = [
    {
      schema_version: 'grant-record.v1',
      grant_id: 'GRT-20261116-0000000000c1',
      capability: 'credential.use',
      scope: {
        tenant_slug: 'child',
        credential_provider: 'anthropic',
        credential_ref: 'anthropic/API_KEY',
        credential_lending: draft.credential_lending,
      },
      purpose: draft.purpose,
      granted_by: { actor_id: approver, role: 'operator', assurance: 'A1' },
      basis: { approval_request_id: 'APR-LEND', approval_channel: 'grant-standing' },
      granted_at: GRANTED_AT,
      expires_at: new Date(Date.parse(GRANTED_AT) + 30 * 86400_000).toISOString(),
      audit_event_id: 'audit',
    },
  ];
  state.approval = {
    id: 'APR-LEND',
    status: 'approved',
    consumption: {
      consumer: 'grant_standing',
      effectRef: 'GRT-20261116-0000000000c1',
      consumedAt: GRANTED_AT,
    },
    accountability: {
      finalDecision: 'human_only',
      effectBinding: grantApprovalEffectBinding(draft),
      payloadHash: computeApprovalPayloadHash(grantApprovalPayload(draft)),
    },
    workflow: {
      approvals: [
        { status: 'approved', decidedByType: 'human', authenticated: true, approvedBy: approver },
      ],
    },
  };
}
const asDotRuntime = <T>(run: () => Promise<T>) =>
  withExecutionContext('organization_operator', run, undefined, 'child', undefined, {
    missionId: 'MSN-DOT-CHILD',
    taskId: 'dot-standing-1',
  });
const input = {
  scope: {
    tier: 'confidential' as const,
    tenant_slug: 'child',
    mission_id: 'MSN-DOT-CHILD',
    task_id: 'dot-standing-1',
  },
  workItemId: 'WI-dot',
};

beforeEach(() => {
  state.memberReads = [];
  // Attestation/personal-owner lookups are not under test; the tenant OWNER check is real.
  setCredentialLendingDepsForTests({
    eligibility: {
      personalOwnerOf: () => undefined,
      installationPerson: () => 'owner',
      borrowerAttested: () => true,
    },
  });
});

describe('tenant-custody lending bound by the resident Dot runtime', () => {
  it('binds a parent key lent to a child tenant: the owner approver is verified through member_owner_reader', async () => {
    lend('user:cfo');
    await asDotRuntime(async () => {
      const binding = await bindAllocatedTaskCredentials(input);
      expect(binding?.secrets).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-parent-key-0001' });
    });
    expect(state.memberReads).toContainEqual({ member: 'cfo', allowed: true });
  });

  it('still rejects a lending approved by a non-owner member', async () => {
    lend('user:mallory');
    await asDotRuntime(async () => {
      // verifyGrantBasis fails → the grant admits nothing → no credential is bound (fail closed).
      expect(await bindAllocatedTaskCredentials(input)).toBeNull();
    });
    expect(state.memberReads).toContainEqual({ member: 'mallory', allowed: true });
  });

  it('organization_operator cannot read member profiles without the grant', () => {
    const file = pathResolver.rootResolve('knowledge/personal/members/cfo.json');
    expect(
      withExecutionContext(
        'organization_operator',
        () => validateReadPermission(file).allowed,
        undefined,
        'child'
      )
    ).toBe(false);
  });
});
