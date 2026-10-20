import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  attestTenantProvider,
  mutateTenant,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestTenantProviderAttestationApproval,
} from '@agent/core/organization/tenant-governance';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';

const mocks = vi.hoisted(() => ({
  loadApprovalRequest: vi.fn(),
  decideApprovalRequest: vi.fn(),
  resolveViewer: vi.fn(),
  resolveMember: vi.fn(),
  scopedVisible: vi.fn(),
}));

vi.mock('../../../../lib/scoped-learning-approval-visibility', () => ({
  scopedLearningApprovalVisibleToViewer: mocks.scopedVisible,
}));
vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () => null,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: mocks.resolveViewer,
  conciergeErrorResponse: (error: unknown, status: number) =>
    new Response(JSON.stringify({ ok: false, error: String(error) }), { status }),
}));
vi.mock('@agent/core/ops-alert', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  resolveMemberByPrincipal: mocks.resolveMember,
  memberBindingDenied: () => false,
}));
vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  loadApprovalRequest: mocks.loadApprovalRequest,
  decideApprovalRequest: mocks.decideApprovalRequest,
}));

import { POST } from './route.js';

const viewer = {
  principalId: 'member:carol',
  source: 'member',
  memberId: 'carol',
  role: 'localadmin',
  tenantSlugs: ['acme', 'beta'],
};
const params = { params: Promise.resolve({ id: 'req-1' }) };

function request(overrides: Record<string, unknown> = {}): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      decision: 'approved',
      channel: 'tenant-provider-attestation',
      presentedDigest: 'shown-digest',
      ...overrides,
    }),
  } as unknown as NextRequest;
}

describe('concierge approval decision tenant binding', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.scopedVisible.mockReturnValue(true);
    mocks.resolveViewer.mockReturnValue({ context: viewer });
    mocks.resolveMember.mockReturnValue({
      member_id: 'carol',
      display_name: 'Carol',
      memberships: [
        { tenant_slug: 'acme', role: 'owner' },
        { tenant_slug: 'beta', role: 'approver' },
      ],
    });
    mocks.loadApprovalRequest.mockReturnValue({
      id: 'req-1',
      scope: { tier: 'confidential', tenant_slug: 'beta', scope_kind: 'tenant' },
      requestedByContext: { tenant_slug: 'acme' },
      work_loop: { context: { tenant_slug: 'acme' } },
      accountability: { finalDecision: 'human_only', payloadHash: 'claim-hash' },
    });
    mocks.decideApprovalRequest.mockImplementation((_role: string, input: object) => ({
      status: 'approved',
      ...input,
    }));
  });

  it.each(['pending', 'approved', 'rejected'])(
    'hides an unavailable scoped-learning %s request before decision',
    async (status) => {
      mocks.scopedVisible.mockReturnValue(false);
      mocks.loadApprovalRequest.mockReturnValue({
        id: 'req-1',
        status,
        scope: {
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'other-org',
          project_id: 'other-project',
        },
      });
      const response = await POST(request(), params);
      expect(response.status).toBe(404);
      expect(mocks.decideApprovalRequest).not.toHaveBeenCalled();
      expect(mocks.resolveMember).not.toHaveBeenCalled();
    }
  );

  it('uses canonical scope for membership and decision attribution before legacy context', async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(mocks.decideApprovalRequest).toHaveBeenCalledWith(
      'sovereign_concierge',
      expect.objectContaining({
        channel: 'tenant-provider-attestation',
        storageChannel: 'tenant-provider-attestation',
        decidedBy: 'user:carol',
        decidedByRole: 'approver',
        decidedByType: 'human',
        authenticated: true,
        presentedDigest: 'shown-digest',
      })
    );
  });

  it('denies a viewer membership on the canonical tenant despite legacy owner context', async () => {
    mocks.resolveMember.mockReturnValue({
      member_id: 'carol',
      display_name: 'Carol',
      memberships: [
        { tenant_slug: 'acme', role: 'owner' },
        { tenant_slug: 'beta', role: 'viewer' },
      ],
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(403);
    expect(mocks.decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('denies a canonical tenant outside the viewer scope even with approver membership', async () => {
    mocks.resolveViewer.mockReturnValue({ context: { ...viewer, tenantSlugs: ['acme'] } });
    const response = await POST(request(), params);
    expect(response.status).toBe(403);
    expect(mocks.decideApprovalRequest).not.toHaveBeenCalled();
  });

  it.each([
    { requestedByContext: { tenant_slug: 'acme' } },
    { requestedByContext: { tenantSlug: 'acme' } },
    { work_loop: { context: { tenant_slug: 'acme' } } },
  ])('preserves the compatibility context for an older request: %j', async (legacy) => {
    mocks.loadApprovalRequest.mockReturnValue({ id: 'req-1', ...legacy });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(mocks.decideApprovalRequest).toHaveBeenCalledWith(
      'sovereign_concierge',
      expect.objectContaining({ decidedByRole: 'owner' })
    );
  });
});

describe('provider attestation through the real decision store', () => {
  let store: typeof import('@agent/core/governance/approval-store');
  let rootDir: string;
  let requestId: string;
  let audit: ReturnType<typeof vi.spyOn>;
  const claim = {
    slug: 'beta',
    provider: 'codex',
    training_use: 'none' as const,
    plan: 'Synthetic enterprise plan',
    basis: 'Synthetic test evidence',
    attested_by: 'human:fixture-owner',
  };

  beforeAll(async () => {
    store = await vi.importActual<typeof import('@agent/core/governance/approval-store')>(
      '@agent/core/governance/approval-store'
    );
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.scopedVisible.mockReturnValue(true);
    rootDir = pathResolver.sharedTmp(`provider-approval-route-${randomUUID()}`);
    safeMkdir(rootDir, { recursive: true });
    audit = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
    mocks.loadApprovalRequest.mockImplementation(store.loadApprovalRequest);
    mocks.decideApprovalRequest.mockImplementation(store.decideApprovalRequest);
    mocks.resolveViewer.mockReturnValue({
      context: {
        ...viewer,
        principal: {
          provider: 'browser-session',
          principalId: 'member:carol',
          actor: { kind: 'human' },
        },
      },
    });
    mocks.resolveMember.mockReturnValue({
      member_id: 'carol',
      display_name: 'Carol',
      memberships: [{ tenant_slug: 'beta', role: 'owner' }],
    });
    requestId = withExecutionContext('sovereign_concierge', () => {
      mutateTenant({ verb: 'create', slug: 'beta', rootDir, apply: true });
      return requestTenantProviderAttestationApproval({
        ...claim,
        rootDir,
        invoker: { actor: 'fixture-requester' },
      }).request_id;
    });
  });

  afterEach(() => {
    audit.mockRestore();
    safeRmSync(store.approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, requestId), {
      force: true,
    });
    safeRmSync(store.approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), {
      force: true,
    });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  function pending() {
    return store.loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, requestId)!;
  }

  function apply(overrides: Partial<typeof claim> = {}) {
    return withExecutionContext('sovereign_concierge', () =>
      attestTenantProvider({
        ...claim,
        ...overrides,
        rootDir,
        approvalRequestId: requestId,
      })
    );
  }

  async function post(presentedDigest = store.computeApprovalPresentedDigest(pending())) {
    return POST(request({ presentedDigest }), { params: Promise.resolve({ id: requestId }) });
  }

  it.each(['owner', 'approver'])(
    'records the %s member decision and applies only the exact claim once',
    async (role) => {
      mocks.resolveMember.mockReturnValue({
        member_id: 'carol',
        display_name: 'Carol',
        memberships: [{ tenant_slug: 'beta', role }],
      });
      const response = await post();
      expect(response.status).toBe(200);
      expect(pending().workflow?.approvals.find((entry) => entry.role === role)).toMatchObject({
        status: 'approved',
        approvedBy: 'user:carol',
        authMethod: 'surface_session',
        decidedByType: 'human',
        authenticated: true,
      });
      expect(() => apply({ plan: 'Different claim' })).toThrow(/different training_use\/plan/);
      expect(apply().approval?.approved_by).toBe('user:carol');
      expect(() => apply()).toThrow(/already used/);
      expect(
        withExecutionContext('sovereign_concierge', () => readTenantProfile('beta', { rootDir }))
          ?.provider_attestations?.codex?.training_use
      ).toBe('none');
    }
  );

  it.each(['viewer', 'out-of-scope', 'agent', 'stale-digest'])(
    'refuses %s without settling the request or applying an attestation',
    async (caseName) => {
      if (caseName === 'viewer')
        mocks.resolveMember.mockReturnValue({
          member_id: 'carol',
          display_name: 'Carol',
          memberships: [{ tenant_slug: 'beta', role: 'viewer' }],
        });
      if (caseName === 'out-of-scope')
        mocks.resolveViewer.mockReturnValue({
          context: {
            ...viewer,
            tenantSlugs: ['acme'],
            principal: { provider: 'browser-session', actor: { kind: 'human' } },
          },
        });
      if (caseName === 'agent')
        mocks.resolveViewer.mockReturnValue({
          context: {
            ...viewer,
            principal: { provider: 'browser-session', actor: { kind: 'agent' } },
          },
        });
      const digest =
        caseName === 'stale-digest'
          ? store.computeApprovalPresentedDigest({ ...pending(), scope: undefined })
          : store.computeApprovalPresentedDigest(pending());
      const response = await post(digest);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(pending().status).toBe('pending');
      expect(() => apply()).toThrow(/is pending/);
      expect(
        withExecutionContext('sovereign_concierge', () => readTenantProfile('beta', { rootDir }))
          ?.provider_attestations?.codex
      ).toBeUndefined();
    }
  );
});
