import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceManagementAuthorization } from '../surface/surface-management-mutations.js';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
interface BindingFixture {
  tenant_slug: string;
  organization_id: string;
  tier: string;
  owner_id: string;
}
interface FirstWorkFixture {
  intent: string;
  management_unit_id?: string;
  tenant_slug?: string;
  organization_id?: string;
  tier?: string;
}
interface ApprovalFixture {
  id: string;
  channel: string;
  status: string;
  scope: { tenant_slug: string; organization_id: string };
  expiresAt?: string;
  applyClaim?: { result: string };
  applyResult?: { result: string };
  revocation?: { result: string };
}
interface ProjectFixture {
  project_id: string;
  tier: string;
  status: string;
  tenant_slug: string;
  organization_id: string;
}
const st = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  binding: null as BindingFixture | null,
  first: null as FirstWorkFixture | null,
  activation: null as { status: 'active' } | null,
  approval: null as ApprovalFixture | null,
  tenant: {
    tenant_slug: 'acme',
    display_name: 'Acme',
    status: 'active',
    isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
  },
  deny: false,
  failRegistration: false,
  registrations: 0,
  probes: 0,
  requests: 0,
  applies: 0,
  firstWrites: 0,
  project: null as ProjectFixture | null,
}));
vi.mock('../authority.js', () => ({
  withExecutionContextAsync: async (_r: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../path-resolver.js', () => ({ pathResolver: { rootDir: () => '/fixture' } }));
vi.mock('../foundation/json.js', () => ({
  readJsonIfPresent: (p: string) => structuredClone(st.files.get(p) ?? null),
  writeJson: (p: string, v: unknown) => st.files.set(p, structuredClone(v)),
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLock: async (_id: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../secure-io.js', () => ({ safeMkdir: vi.fn() }));
vi.mock('../surface/surface-management-mutations.js', () => ({
  SurfaceManagementError: class extends Error {
    constructor(
      public code: string,
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
  verifySurfaceManagementAuthorization: vi.fn(async () => {
    if (st.deny) throw new Error('owner revoked');
  }),
}));
vi.mock('./tenant-registry.js', () => ({ readTenantProfile: () => st.tenant }));
vi.mock('./company-bootstrap.js', () => ({ listCompanyVerticals: () => ['saas-product-company'] }));
vi.mock('./company-onboarding.js', () => ({
  onboardAiCompany: (input: { accountableHumanId: string; firstWork: string }) => {
    st.registrations++;
    if (st.failRegistration) throw new Error('fixture registration failure');
    st.binding = {
      tenant_slug: 'acme',
      organization_id: 'acme',
      tier: 'confidential',
      owner_id: input.accountableHumanId,
    };
    st.files.set('/fixture/customer/acme/onboarding/ai-company-readiness.json', {
      accountable_human: { resource_id: input.accountableHumanId },
      first_work: { goal: input.firstWork },
    });
    return { workerNhiRecorded: true };
  },
}));
vi.mock('./onboarding-context.js', () => ({
  loadOnboardingContextBinding: () => st.binding,
  loadOnboardingFirstWorkRecord: () => st.first,
  resolveOnboardingFirstWork: () => {
    if (!st.activation) throw new Error('activation required');
    return { project_required: true, resolution: { work_shape: 'solution_project' } };
  },
  applyOnboardingFirstWork: (input: { intent: string }) => {
    st.firstWrites++;
    st.first = { intent: input.intent };
  },
}));
vi.mock('../project/project-registry.js', () => ({ loadProjectRecord: () => st.project }));
vi.mock('./tenant-activation.js', () => ({ loadTenantActivation: () => st.activation }));
vi.mock('./tenant-activation-probe.js', () => ({
  runTenantActivationProbes: vi.fn(async () => {
    st.probes++;
    return {
      passed: true,
      evidence_ref: 'server-probe',
      results: { viewer_scope: { passed: true, detail: 'audit-only' } },
    };
  }),
}));
vi.mock('./tenant-activation-approval.js', () => ({
  requestTenantActivationApproval: vi.fn(async () => {
    st.requests++;
    st.approval = {
      id: 'approval-1',
      channel: 'tenant-activation',
      status: 'pending',
      scope: { tenant_slug: 'acme', organization_id: 'acme' },
    };
    return { approval: st.approval, presentedDigest: 'digest' };
  }),
  applyApprovedTenantActivation: vi.fn(async () => {
    st.applies++;
    st.activation = { status: 'active' };
  }),
}));
vi.mock('../governance/approval-store.js', () => ({ loadApprovalRequest: () => st.approval }));
vi.mock('../governance/approval-presentation.js', () => ({
  computeApprovalPresentedDigest: () => 'digest',
}));
import { executeCompanySetup } from './company-setup-workflow.js';
type SetupResult = Awaited<ReturnType<typeof executeCompanySetup>>;
function reviewOf(result: SetupResult) {
  if (!('review' in result)) throw new Error('Expected a review result');
  return result.review;
}
function setupOf(result: SetupResult) {
  if (!('setup' in result)) throw new Error('Expected a setup result');
  return result.setup;
}
function currentApproval(): ApprovalFixture {
  if (!st.approval) throw new Error('Expected a fixture approval');
  return st.approval;
}
const auth: SurfaceManagementAuthorization = {
  actorId: 'user:owner',
  memberId: 'owner',
  tenantSlug: 'acme',
  allowedOrganizationIds: 'all',
  allowedProjectIds: 'all',
};
const principal: ResolvedPrincipal = {
  actor: { kind: 'human', id: 'user:owner' },
  principalId: 'fixture-owner',
  provider: 'fixture',
  role: 'localadmin',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential'],
  source: 'token',
  assurance: 'medium',
  memberId: 'owner',
};
const command = { vertical: 'saas-product-company', firstWork: 'Create the meeting checklist' };
async function register() {
  const p = await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
  if (!('review' in p)) throw Error('preview');
  return executeCompanySetup(
    auth,
    { action: 'register_company', ...command, reviewDigest: p.review.digest },
    principal
  );
}
beforeEach(() => {
  st.files.clear();
  Object.assign(st, {
    binding: null,
    first: null,
    activation: null,
    approval: null,
    deny: false,
    failRegistration: false,
    registrations: 0,
    probes: 0,
    requests: 0,
    applies: 0,
    firstWrites: 0,
    project: null,
  });
  vi.clearAllMocks();
});
describe('company setup workflow mediation', () => {
  it('status and preview never register, probe or request approval', async () => {
    await executeCompanySetup(auth, { action: 'status' }, principal);
    await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
    expect(st.files.size).toBe(0);
    expect(st.registrations + st.probes + st.requests).toBe(0);
  });
  it('binds review to member and exact fields, rejecting stale input', async () => {
    const p = await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
    await expect(
      executeCompanySetup(
        auth,
        {
          action: 'register_company',
          ...command,
          firstWork: 'Changed',
          reviewDigest: reviewOf(p).digest,
        },
        principal
      )
    ).rejects.toThrow('Review');
    expect(st.registrations).toBe(0);
  });
  it('registers once and returns exact repeated submission without overwrite', async () => {
    const p = await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
    const c = {
      action: 'register_company' as const,
      ...command,
      reviewDigest: reviewOf(p).digest,
    };
    await executeCompanySetup(auth, c, principal);
    await executeCompanySetup(auth, c, principal);
    expect(st.registrations).toBe(1);
  });
  it('rejects changed reviewed actor', async () => {
    const p = await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
    await expect(
      executeCompanySetup(
        { ...auth, memberId: 'other', actorId: 'user:other' },
        { action: 'register_company', ...command, reviewDigest: reviewOf(p).digest },
        principal
      )
    ).rejects.toThrow('Review');
  });
  it('rejects mismatched existing accountable owner before writes', async () => {
    st.binding = {
      tenant_slug: 'acme',
      organization_id: 'acme',
      tier: 'confidential',
      owner_id: 'human:other',
    };
    await expect(register()).rejects.toThrow('accountability');
    expect(st.files.size).toBe(0);
  });
  it('does not use flat owner labels or narrowed organization grant to provision', async () => {
    await expect(
      executeCompanySetup({ ...auth, actorId: 'human:owner' }, { action: 'status' }, principal)
    ).rejects.toThrow('Verified');
    await expect(
      executeCompanySetup(
        { ...auth, allowedOrganizationIds: ['acme'] },
        { action: 'preview_company', ...command },
        principal
      )
    ).rejects.toThrow('tenant-wide');
  });
  it('records partial registration failure and refuses automatic retry', async () => {
    st.failRegistration = true;
    const p = await executeCompanySetup(auth, { action: 'preview_company', ...command }, principal);
    const c = {
      action: 'register_company' as const,
      ...command,
      reviewDigest: reviewOf(p).digest,
    };
    await expect(executeCompanySetup(auth, c, principal)).rejects.toThrow('fixture');
    await expect(executeCompanySetup(auth, c, principal)).rejects.toThrow('already exists');
    expect(st.registrations).toBe(1);
    expect(st.files.get('/fixture/customer/acme/onboarding/web-company-setup.json')).toMatchObject({
      registration: { state: 'failed' },
    });
  });
  it('requires real server probe before requesting human activation', async () => {
    await register();
    await expect(
      executeCompanySetup(auth, { action: 'request_activation' }, principal)
    ).rejects.toThrow('readiness');
    await executeCompanySetup(auth, { action: 'probe' }, principal);
    await executeCompanySetup(auth, { action: 'request_activation' }, principal);
    expect(st.requests).toBe(1);
    expect(st.applies).toBe(0);
  });
  it('does not apply another company approval ID', async () => {
    await register();
    await expect(
      executeCompanySetup(auth, { action: 'apply_activation', requestId: 'other' }, principal)
    ).rejects.toThrow('Refresh');
    expect(st.applies).toBe(0);
  });
  it('keeps first-work preview blocked before activation and scoped after activation', async () => {
    await register();
    await expect(
      executeCompanySetup(auth, { action: 'preview_first_work' }, principal)
    ).rejects.toThrow('activation');
    st.activation = { status: 'active' };
    await expect(
      executeCompanySetup(
        { ...auth, allowedProjectIds: [] },
        { action: 'preview_first_work' },
        principal
      )
    ).rejects.toThrow('project access');
    expect(st.firstWrites).toBe(0);
  });
  it('refuses an existing project instead of silently reusing it', async () => {
    await register();
    st.activation = { status: 'active' };
    st.project = {
      project_id: 'PRJ-ACME-FIRST',
      tier: 'public',
      status: 'archived',
      tenant_slug: 'acme',
      organization_id: 'acme',
    };
    await expect(
      executeCompanySetup(auth, { action: 'preview_first_work' }, principal)
    ).rejects.toThrow('already exists');
    expect(st.firstWrites).toBe(0);
  });
  it('requires current membership on subsequent actions', async () => {
    await register();
    st.deny = true;
    await expect(executeCompanySetup(auth, { action: 'probe' }, principal)).rejects.toThrow(
      'revoked'
    );
    expect(st.probes).toBe(0);
  });
  it.each(['applyClaim', 'applyResult', 'revocation'] as const)(
    'requires fresh review after %s',
    async (field) => {
      await register();
      await executeCompanySetup(auth, { action: 'probe' }, principal);
      await executeCompanySetup(auth, { action: 'request_activation' }, principal);
      currentApproval().status = 'approved';
      currentApproval()[field] = { result: 'failed' };
      const r = setupOf(await executeCompanySetup(auth, { action: 'status' }, principal));
      expect(r.stage).toBe('registered');
      expect(r.canRequestActivation).toBe(false);
      await executeCompanySetup(auth, { action: 'probe' }, principal);
      expect(
        setupOf(await executeCompanySetup(auth, { action: 'status' }, principal))
          .canRequestActivation
      ).toBe(true);
      expect(currentApproval()[field]).toBeDefined();
    }
  );
  it('projects expired approvals as needing a new review', async () => {
    await register();
    await executeCompanySetup(auth, { action: 'probe' }, principal);
    await executeCompanySetup(auth, { action: 'request_activation' }, principal);
    currentApproval().expiresAt = '2000-01-01T00:00:00Z';
    const r = await executeCompanySetup(auth, { action: 'status' }, principal);
    expect(setupOf(r).stage).toBe('registered');
    expect(setupOf(r).activationApproval?.status).toBe('expired');
    expect(setupOf(r).canRequestActivation).toBe(false);
    await executeCompanySetup(auth, { action: 'probe' }, principal);
    expect(
      setupOf(await executeCompanySetup(auth, { action: 'status' }, principal)).canRequestActivation
    ).toBe(true);
  });
});
