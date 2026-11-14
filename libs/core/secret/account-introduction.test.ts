import { assertAccountIntroductionProvisioning } from '../foundation/account-provision-admission.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
const m = vi.hoisted(() => ({
  binding: {} as ServiceBindingRecord,
  member: {
    member_id: 'owner',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  },
  installed: { ready: true, ownerId: 'user:owner', agentId: 'agent:installed' },
  role: 'sovereign_concierge',
  tenant: undefined as string | undefined,
  state: { generation: null as string | null, pendingApprovalId: undefined as string | undefined },
  record: null as ApprovalRequestRecord | null,
  personal: true,
  inPersonal: false,
  create: vi.fn(),
  claim: vi.fn(),
  result: vi.fn(),
  store: vi.fn(),
  provision: vi.fn(),
  writer: 'broker-config',
  saveState: vi.fn(),
  checkHuman: vi.fn(),
}));
vi.mock('../authority.js', () => ({ resolveAssumedRole: () => m.role }));
vi.mock('../shell/sandbox-policy.js', () => ({ getPluginExecutionContext: () => undefined }));
vi.mock('../foundation/credential-binding.js', () => ({
  credentialExecutionIdentity: () => ({ tenantSlug: m.tenant }),
}));
vi.mock('../organization/member-registry.js', () => ({
  readMemberProfile: () => m.member,
  isValidMemberId: (id: string) => /^[a-z][a-z0-9-]*$/.test(id),
}));
vi.mock('../organization/onboarding-runtime-identity.js', () => ({
  inspectInstalledOnboardingRuntime: () => m.installed,
}));
vi.mock('../service/service-binding-reader.js', () => ({
  loadServiceBindingRecord: () => m.binding,
}));
vi.mock('../service/service-endpoint-registry.js', () => ({
  getServiceEndpointRecord: () => ({ credential_suffixes: { accessToken: ['TOKEN'] } }),
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLock: async (_key: string, run: () => unknown) => run(),
}));
vi.mock('../governance/authenticated-personal-approvals.js', () => ({
  withAuthenticatedPersonalApprovals: (_p: unknown, run: () => unknown) => {
    if (!m.personal) return null;
    m.inPersonal = true;
    try {
      return run();
    } finally {
      m.inPersonal = false;
    }
  },
}));
vi.mock('../governance/approval-store.js', () => ({
  computeApprovalPayloadHash: (value: unknown) => JSON.stringify(value),
  createApprovalRequest: (_role: string, data: Record<string, unknown>) => {
    m.create(data, m.inPersonal);
    m.record = { ...data, id: 'approval-1', status: 'pending' } as ApprovalRequestRecord;
    return m.record;
  },
  loadApprovalRequest: () => m.record,
  listApprovalRequests: () => (m.record ? [m.record] : []),
  claimApprovalApply: () => {
    m.claim();
    m.record!.applyClaim = { claimId: 'claim-1' } as ApprovalRequestRecord['applyClaim'];
    return m.record;
  },
  recordApprovalApplyResult: () => {
    m.result();
    m.record!.applyResult = { result: 'success' } as ApprovalRequestRecord['applyResult'];
  },
}));
vi.mock('../governance/approval-store-reader.js', () => ({
  isApprovalRequestExpired: (r: ApprovalRequestRecord) => Date.parse(r.expiresAt!) < Date.now(),
}));
vi.mock('../governance/approval-separation-of-duties.js', () => ({
  assertApprovalUsable: vi.fn(),
}));
vi.mock('../governance/approval-human-decision.js', () => ({
  validateHumanFinalDecision: () => m.checkHuman(),
}));
vi.mock('../governance/approval-presentation.js', () => ({
  approvalPresentedDigestMatches: (_r: unknown, digest: string) => digest === 'presented',
  computeApprovalPresentedDigest: () => 'presented',
}));
vi.mock('./secret-guard.js', () => ({
  loadLocalAccountRegistration: () => ({ ...m.state }),
  storeLocalAccountRegistration: (_i: unknown, state: typeof m.state) => {
    m.saveState(state);
    m.state = { ...state };
  },
  storeLocalAccountMaterial: (i: object, material: object) => {
    m.store(i, material);
    return { ...i, generation: '11111111-1111-4111-8111-111111111111' };
  },
}));
vi.mock('./account-broker.js', () => ({
  describeAccountBroker: () => (m.writer ? { brokerId: m.writer } : null),
  provisionAccountMaterial: async (input: unknown) => {
    const { assertAccountIntroductionProvisioning } =
      await import('../foundation/account-provision-admission.js');
    assertAccountIntroductionProvisioning(
      input as Parameters<typeof assertAccountIntroductionProvisioning>[0]
    );
    return m.provision(input);
  },
}));
import {
  previewAccountIntroduction,
  proposeAccountIntroduction,
  accountIntroductionStatus,
  applyAccountIntroduction,
} from './account-introduction.js';
const principal = {
  requesterId: 'user:owner',
  accountableId: 'user:owner',
  personalOwner: true,
  tenantSlugs: ['acme'],
};
const token = { SLACK_TOKEN: 'never-leak-this-token' };
function propose() {
  const preview = previewAccountIntroduction(principal, 'slack-work');
  return proposeAccountIntroduction(principal, 'slack-work', preview);
}
function approve() {
  propose();
  Object.assign(m.record!, {
    status: 'approved',
    decidedBy: 'user:owner',
    verifiedPresentedDigest: 'presented',
  });
}
const apply = () =>
  applyAccountIntroduction(principal, 'slack-work', { approval_id: 'approval-1', material: token });
beforeEach(() => {
  vi.clearAllMocks();
  m.binding = {
    binding_id: 'slack-work',
    service_id: 'slack',
    service_type: 'slack',
    scope: 'workspace',
    target: 'example',
    allowed_actions: ['read'],
    approval_policy: { read: 'allowed' },
    secret_refs: ['SLACK_TOKEN'],
    auth_mode: 'secret-guard',
    owner_kind: 'person',
    owner_ref: 'user:owner',
  };
  m.member = {
    member_id: 'owner',
    status: 'active',
    memberships: [{ tenant_slug: 'acme', role: 'owner' }],
  };
  m.installed = { ready: true, ownerId: 'user:owner', agentId: 'agent:installed' };
  m.role = 'sovereign_concierge';
  m.tenant = undefined;
  m.state = { generation: null, pendingApprovalId: undefined };
  m.record = null;
  m.personal = true;
  m.writer = 'broker-config';
  m.store.mockReset();
  m.provision.mockReset();
  m.saveState.mockReset();
  m.result.mockReset();
  m.checkHuman.mockReset();
});
describe('approved exact-account introduction', () => {
  it('keeps personal requests in their partition with separate human and NHI identities', () => {
    propose();
    expect(m.create.mock.calls[0]![1]).toBe(true);
    expect(m.record!.requestedBy).toBe('agent:installed');
    expect(m.record!.accountability!.finalDecision).toBe('human_only');
    expect(JSON.stringify(m.record)).not.toContain(token.SLACK_TOKEN);
    expect(accountIntroductionStatus(principal, 'slack-work', 'approval-1').can_apply).toBe(false);
  });
  it('stores a personal exact generation without broker allocation and refuses replay', async () => {
    approve();
    expect(accountIntroductionStatus(principal, 'slack-work', 'approval-1').can_apply).toBe(true);
    const result = await apply();
    expect(result.status).toBe('applied');
    expect(m.store).toHaveBeenCalledOnce();
    expect(m.provision).not.toHaveBeenCalled();
    expect(m.state.pendingApprovalId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token.SLACK_TOKEN);
    await expect(apply()).rejects.toThrow('recovery_required');
  });
  it('provisions only approved organization accounts', async () => {
    Object.assign(m.binding, {
      owner_kind: 'organization',
      owner_ref: 'acme',
      tenant_slug: 'acme',
    });
    approve();
    await apply();
    expect(m.provision).toHaveBeenCalledOnce();
    expect(m.create.mock.calls[0]![1]).toBe(false);
    expect(m.record!.scope?.tier).toBe('confidential');
  });
  it('rejects direct provisioning without the private apply admission', () => {
    expect(() =>
      assertAccountIntroductionProvisioning({
        brokerId: 'broker',
        reference: {
          serviceId: 'slack',
          bindingId: 'slack-work',
          ownerKind: 'organization',
          ownerRef: 'acme',
          tenantSlug: 'acme',
          generation: 'g',
        },
        expectedGeneration: null,
        material: token,
      })
    ).toThrow('ACCOUNT_BROKER_UNAVAILABLE');
  });
  it.each([
    'owner',
    'tenant',
    'runtime',
    'role',
    'personal-partition',
    'service',
    'session',
    'legacy-owner',
  ])('rejects %s boundary mismatch', (mode) => {
    if (mode === 'owner') m.binding.owner_ref = 'user:other';
    if (mode === 'tenant')
      Object.assign(m.binding, {
        owner_kind: 'organization',
        owner_ref: 'foreign',
        tenant_slug: 'foreign',
      });
    if (mode === 'runtime') m.installed.ownerId = 'user:other';
    if (mode === 'role') m.role = 'worker';
    if (mode === 'personal-partition') m.personal = false;
    if (mode === 'service') m.binding.secret_refs = ['GITHUB_TOKEN'];
    if (mode === 'session') m.binding.auth_mode = 'session';
    if (mode === 'legacy-owner') delete m.binding.owner_kind;
    expect(() => propose()).toThrow();
    expect(m.create).not.toHaveBeenCalled();
  });
  it('requires explicit broker writer before an organization preview', () => {
    Object.assign(m.binding, {
      owner_kind: 'organization',
      owner_ref: 'acme',
      tenant_slug: 'acme',
    });
    m.writer = '';
    expect(propose).toThrow('writer required');
  });
  it.each([
    'pending',
    'expired',
    'other-decider',
    'presentation',
    'human-proof',
    'binding',
    'generation',
    'extra-secret',
  ])('refuses %s before material collection', async (mode) => {
    approve();
    if (mode === 'pending') m.record!.status = 'pending';
    if (mode === 'expired') m.record!.expiresAt = '2000-01-01T00:00:00Z';
    if (mode === 'other-decider') m.record!.decidedBy = 'user:other';
    if (mode === 'presentation') m.record!.verifiedPresentedDigest = 'stale';
    if (mode === 'human-proof')
      m.checkHuman.mockImplementation(() => {
        throw Error('human required');
      });
    if (mode === 'binding') m.binding.target = 'changed';
    if (mode === 'generation') m.state.generation = '22222222-2222-4222-8222-222222222222';
    await expect(
      applyAccountIntroduction(principal, 'slack-work', {
        approval_id: 'approval-1',
        material: mode === 'extra-secret' ? { ...token, GITHUB_TOKEN: 'foreign' } : token,
      })
    ).rejects.toThrow();
    expect(m.store).not.toHaveBeenCalled();
    expect(m.claim).not.toHaveBeenCalled();
  });
  it.each(['material', 'broker', 'receipt', 'state'])(
    'fences incomplete %s writes and rejects a new request',
    async (mode) => {
      Object.assign(m.binding, {
        owner_kind: 'organization',
        owner_ref: 'acme',
        tenant_slug: 'acme',
      });
      approve();
      if (mode === 'material')
        m.store.mockImplementation(() => {
          throw Error(token.SLACK_TOKEN);
        });
      if (mode === 'broker') m.provision.mockRejectedValue(Error(token.SLACK_TOKEN));
      if (mode === 'receipt')
        m.result.mockImplementation(() => {
          throw Error(token.SLACK_TOKEN);
        });
      if (mode === 'state')
        m.saveState.mockImplementationOnce(() => {
          throw Error(token.SLACK_TOKEN);
        });
      await expect(apply()).rejects.toThrow('[ACCOUNT_INTRODUCTION] recovery_required');
      expect(accountIntroductionStatus(principal, 'slack-work', 'approval-1').can_apply).toBe(
        false
      );
      expect(propose).toThrow('recovery_required');
      await expect(apply()).rejects.toThrow('recovery_required');
    }
  );
  it('refuses stale broker completion after binding mutation', async () => {
    Object.assign(m.binding, {
      owner_kind: 'organization',
      owner_ref: 'acme',
      tenant_slug: 'acme',
    });
    approve();
    m.provision.mockImplementation(() => {
      m.binding.target = 'changed';
    });
    await expect(apply()).rejects.toThrow('recovery_required');
    expect(m.result).not.toHaveBeenCalled();
  });
});
