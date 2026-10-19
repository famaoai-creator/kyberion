import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { readJson, writeJson } from '../foundation/json.js';
import { writeTenantProfile } from './tenant-registry.js';
import { readMemberProfile, writeMemberProfile } from './member-registry.js';
import { applyOnboardingContextBinding } from './onboarding-context.js';
import {
  tenantActivationProbeEvidenceDir,
  TENANT_ACTIVATION_PROBE_CHECKS,
  TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
} from './tenant-activation.js';
import {
  applyApprovedTenantActivation,
  requestTenantActivationApproval,
  readTenantActivationApproval,
  TENANT_ACTIVATION_APPROVAL_CHANNEL,
  TENANT_ACTIVATION_EVIDENCE_MAX_AGE_MS,
} from './tenant-activation-approval.js';
import {
  approvalRequestLogicalPath,
  approvalStoreRoots,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  decideApprovalRequest,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { writeGovernedArtifactJson } from '../workforce/artifact-store.js';
import * as store from '../governance/approval-store.js';
import * as activation from './tenant-activation.js';
import * as activationApproval from './tenant-activation-approval.js';
import * as jsonIo from '../foundation/json.js';
import * as secureIo from '../secure-io.js';
import * as tenantRegistry from './tenant-registry.js';
import * as onboarding from './onboarding-context.js';
import * as companyBootstrap from './company-bootstrap.js';
import { executeCompanySetup } from './company-setup-workflow.js';
import { pathResolver } from '../path-resolver.js';

const fixture = vi.hoisted(() => ({
  rootDir: '',
  lifecycle: 'active',
  identityTenant: 'activation-test',
  serviceReady: true,
  verificationCalls: 0,
  onPreflight: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../agent/agent-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agent-identity.js')>()),
  getAgentIdentity: (id: string) => ({
    nhi_id: id,
    kind: 'agent',
    display_name: 'Synthetic worker',
    accountable_human_id: 'user:founder',
    affiliation: { organization_id: 'org-test', tenant_slug: fixture.identityTenant },
    lifecycle_status: fixture.lifecycle,
    created_at: '2026-01-01T00:00:00.000Z',
  }),
}));
vi.mock('../service/service-preflight.js', () => ({
  runServicePreflight: async ({ serviceId }: { serviceId: string }) => {
    await fixture.onPreflight?.();
    return {
      ready: fixture.serviceReady,
      reports: [
        {
          serviceId,
          status: fixture.serviceReady ? 'ready' : 'unavailable',
          authReady: fixture.serviceReady,
          directProbeReady: null,
          runtimeReady: true,
          reason: 'synthetic',
        },
      ],
    };
  },
}));
vi.mock('../surface/surface-management-mutations.js', () => ({
  SurfaceManagementError: class extends Error {
    constructor(_code: string, _status: number, message: string) {
      super(message);
    }
  },
  resolveSurfaceManagementAuthorization: async (auth: { memberId: string; tenantSlug: string }) => {
    fixture.verificationCalls += 1;
    const member = withExecutionContext('sovereign_concierge', () =>
      readMemberProfile(auth.memberId, { rootDir: fixture.rootDir })
    );
    const membership = member?.memberships.find(
      (entry) => entry.tenant_slug === auth.tenantSlug && entry.role === 'owner'
    );
    if (!member || member.status !== 'active' || !membership)
      throw new Error('An active owner membership is required.');
    return { ...auth, tenantSlug: membership.tenant_slug };
  },
  verifySurfaceManagementAuthorization: async (auth: { memberId: string; tenantSlug: string }) => {
    fixture.verificationCalls += 1;
    const member = withExecutionContext('sovereign_concierge', () =>
      readMemberProfile(auth.memberId, { rootDir: fixture.rootDir })
    );
    if (
      !member ||
      member.status !== 'active' ||
      !member.memberships.some(
        (entry) => entry.tenant_slug === auth.tenantSlug && entry.role === 'owner'
      )
    )
      throw new Error('An active owner membership is required.');
  },
}));
vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));

const auth = {
  actorId: 'user:founder',
  memberId: 'founder',
  tenantSlug: 'activation-test',
  allowedOrganizationIds: ['org-test'],
  allowedProjectIds: [],
};
const principal: ResolvedPrincipal = {
  actor: { kind: 'human', id: auth.actorId },
  principalId: auth.actorId,
  memberId: auth.memberId,
  provider: 'browser-session',
  source: 'token',
  assurance: 'high',
  role: 'owner',
  tenantSlugs: [auth.tenantSlug],
  organizationIds: ['org-test'],
  projectIds: [],
  tierAccess: ['confidential'],
};
const scope = {
  customerSlug: 'activation-test-company',
  tenantSlug: auth.tenantSlug,
  organizationId: 'org-test',
  tier: 'confidential' as const,
};
const nhiIds = ['kyberion://agent/org-test/worker'];
const approvalIds: string[] = [];
let evidenceFile = '';
let input: Parameters<typeof requestTenantActivationApproval>[1];
const context = <T>(fn: () => Promise<T>) =>
  withExecutionContextAsync('sovereign_concierge', fn, undefined, auth.tenantSlug, 'org-test');
const modify = (fn: () => void) =>
  withExecutionContext('sovereign_concierge', fn, undefined, auth.tenantSlug, 'org-test');
function changeEvidence(patch: Record<string, unknown>) {
  modify(() =>
    writeJson(evidenceFile, { ...readJson<Record<string, unknown>>(evidenceFile), ...patch })
  );
}
async function request() {
  const result = await context(() =>
    requestTenantActivationApproval(auth, input, principal, { rootDir: fixture.rootDir })
  );
  approvalIds.push(result.approval.id);
  return result.approval;
}
function decide(record: ApprovalRequestRecord, overrides: Record<string, unknown> = {}) {
  return decideApprovalRequest('mission_controller', {
    channel: TENANT_ACTIVATION_APPROVAL_CHANNEL,
    requestId: record.id,
    decision: 'approved',
    decidedBy: auth.actorId,
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderPrincipal: principal,
    presentedDigest: computeApprovalPresentedDigest(record),
    ...overrides,
  });
}
function apply(record: ApprovalRequestRecord, who = principal) {
  return context(() =>
    applyApprovedTenantActivation(auth, { approvalRequestId: record.id }, who, {
      rootDir: fixture.rootDir,
    })
  );
}
function replaceRecord(record: ApprovalRequestRecord) {
  writeGovernedArtifactJson(
    'mission_controller',
    approvalRequestLogicalPath(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id),
    record
  );
}

beforeEach(() => {
  vi.stubEnv('KYBERION_VIEWER_SCOPE', 'warn');
  fixture.rootDir = path.join(
    process.cwd(),
    'active/shared/tmp',
    'activation-approval-' + randomUUID()
  );
  fixture.lifecycle = 'active';
  fixture.identityTenant = 'activation-test';
  fixture.serviceReady = true;
  fixture.onPreflight = undefined;
  fixture.verificationCalls = 0;
  modify(() => {
    safeMkdir(path.join(fixture.rootDir, 'customer', scope.customerSlug), { recursive: true });
    safeWriteFile(
      path.join(fixture.rootDir, 'customer', scope.customerSlug, 'organization-profile.json'),
      JSON.stringify({
        version: '1.0.0',
        organization_id: scope.organizationId,
        name: 'Synthetic company',
        mission_defaults: { default_mission_class: 'general' },
        team_defaults: { default_team_template: 'default' },
        llm: { default_profile: 'default' },
      })
    );
    writeTenantProfile(
      {
        tenant_slug: auth.tenantSlug,
        tenant_id: auth.tenantSlug,
        display_name: 'Synthetic tenant',
        status: 'active',
        assigned_role: 'owner',
        isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
      },
      { rootDir: fixture.rootDir }
    );
    const now = new Date().toISOString();
    writeMemberProfile(
      {
        member_id: auth.memberId,
        display_name: 'Synthetic owner',
        status: 'active',
        memberships: [{ tenant_slug: auth.tenantSlug, role: 'owner' }],
        access_registrations: [],
        created_at: now,
        updated_at: now,
      },
      { rootDir: fixture.rootDir }
    );
    applyOnboardingContextBinding({ ...scope, ownerId: 'human:founder', rootDir: fixture.rootDir });
    const dir = tenantActivationProbeEvidenceDir(scope, fixture.rootDir);
    safeMkdir(dir, { recursive: true });
    evidenceFile = path.join(dir, 'probe-synthetic.json');
    const results = Object.fromEntries(
      TENANT_ACTIVATION_PROBE_CHECKS.map((check) => [
        check,
        {
          passed: true,
          detail: 'synthetic',
          ...(check === 'service_readiness'
            ? { services: { calendar: { passed: true, detail: 'synthetic' } } }
            : {}),
        },
      ])
    );
    writeJson(evidenceFile, {
      version: '1.0.0',
      kind: TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
      customer_slug: scope.customerSlug,
      tenant_slug: scope.tenantSlug,
      organization_id: scope.organizationId,
      tier: scope.tier,
      nhi_ids: nhiIds,
      created_at: new Date(Date.now() - 1000).toISOString(),
      results,
    });
  });
  input = {
    customerSlug: scope.customerSlug,
    organizationId: scope.organizationId,
    tier: scope.tier,
    nhiIds,
    serviceIds: ['calendar'],
    evidenceRef: path.relative(fixture.rootDir, evidenceFile),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  modify(() => safeRmSync(fixture.rootDir, { recursive: true, force: true }));
  approvalIds.splice(0);
  const roots = approvalStoreRoots();
  for (const root of [roots.coordination, roots.observability])
    safeRmSync(pathResolver.resolve(root, TENANT_ACTIVATION_APPROVAL_CHANNEL), {
      recursive: true,
      force: true,
    });
});

describe('exact human tenant activation approval', () => {
  it('persists a verified presented decision and activates once with a durable success receipt', async () => {
    const record = await request();
    expect(record.scope).toEqual(
      expect.objectContaining({
        scope_kind: 'tenant',
        tenant_slug: auth.tenantSlug,
        organization_id: scope.organizationId,
        tier: 'confidential',
      })
    );
    const payload = JSON.parse(record.sourceText!);
    expect(Object.keys(payload.snapshot.owner).sort()).toEqual([
      'member_id',
      'memberships',
      'status',
    ]);
    expect(payload.snapshot.tenant.provider_attestations).toBeUndefined();
    const approved = decide(record);
    expect(approved.verifiedPresentedDigest).toBe(computeApprovalPresentedDigest(record));
    expect((await apply(record)).status).toBe('active');
    const persisted = loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)!;
    expect(persisted.applyClaim?.startedBy).toBe(auth.actorId);
    expect(persisted.applyResult?.result).toBe('success');
    expect(fixture.verificationCalls).toBeGreaterThanOrEqual(5);
    await expect(apply(record)).rejects.toThrow(/unused/);
  });
  it('does not expose an approval to another tenant even for the same multi-tenant owner', async () => {
    const record = await request();
    modify(() => {
      const owner = readMemberProfile(auth.memberId, { rootDir: fixture.rootDir })!;
      writeMemberProfile(
        {
          ...owner,
          memberships: [...owner.memberships, { tenant_slug: 'other-tenant', role: 'owner' }],
        },
        { rootDir: fixture.rootDir }
      );
    });
    await expect(
      context(() =>
        readTenantActivationApproval(
          { ...auth, tenantSlug: 'other-tenant' },
          { approvalRequestId: record.id },
          { ...principal, tenantSlugs: 'all' }
        )
      )
    ).rejects.toThrow(/Approval scope/);
  });
  it('composes the company workflow with the real request, human decision and apply service', async () => {
    const companyTenant = 'org-test';
    const companyScope = {
      customerSlug: companyTenant,
      tenantSlug: companyTenant,
      organizationId: companyTenant,
      tier: 'confidential' as const,
    };
    fixture.identityTenant = companyTenant;
    modify(() => {
      safeMkdir(path.join(fixture.rootDir, 'customer', companyTenant), { recursive: true });
      writeJson(
        path.join(fixture.rootDir, 'customer', companyTenant, 'organization-profile.json'),
        {
          version: '1.0.0',
          organization_id: companyTenant,
          name: 'Synthetic composed company',
          mission_defaults: { default_mission_class: 'general' },
          team_defaults: { default_team_template: 'default' },
          llm: { default_profile: 'default' },
        }
      );
      writeTenantProfile(
        {
          tenant_slug: companyTenant,
          tenant_id: companyTenant,
          display_name: 'Synthetic composed tenant',
          status: 'active',
          assigned_role: 'owner',
          isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
        },
        { rootDir: fixture.rootDir }
      );
      const owner = readMemberProfile(auth.memberId, { rootDir: fixture.rootDir })!;
      writeMemberProfile(
        {
          ...owner,
          memberships: [...owner.memberships, { tenant_slug: companyTenant, role: 'owner' }],
        },
        { rootDir: fixture.rootDir }
      );
      applyOnboardingContextBinding({
        ...companyScope,
        ownerId: 'human:founder',
        rootDir: fixture.rootDir,
      });
      const dir = tenantActivationProbeEvidenceDir(companyScope, fixture.rootDir);
      safeMkdir(dir, { recursive: true });
      const file = path.join(dir, 'probe-composed.json');
      const results = Object.fromEntries(
        TENANT_ACTIVATION_PROBE_CHECKS.map((check) => [
          check,
          {
            passed: true,
            detail: 'synthetic',
            ...(check === 'service_readiness' ? { services: {} } : {}),
          },
        ])
      );
      writeJson(file, {
        version: '1.0.0',
        kind: TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
        customer_slug: companyTenant,
        tenant_slug: companyTenant,
        organization_id: companyTenant,
        tier: 'confidential',
        nhi_ids: ['kyberion://agent/org-test/ceo-operator'],
        created_at: new Date(Date.now() - 1000).toISOString(),
        results,
      });
      writeJson(
        path.join(fixture.rootDir, 'customer', companyTenant, 'onboarding/web-company-setup.json'),
        {
          evidenceRef: path.relative(fixture.rootDir, file),
          probePassed: true,
          probeCheckedAt: new Date().toISOString(),
        }
      );
    });
    const originalReadTenant = tenantRegistry.readTenantProfile;
    const originalReadBinding = onboarding.loadOnboardingContextBinding;
    const realRoot = pathResolver.rootDir();
    const companyRoot = path.join(realRoot, 'customer', companyTenant);
    const remap = (file: string) =>
      file === companyRoot || file.startsWith(companyRoot + path.sep)
        ? path.join(fixture.rootDir, path.relative(realRoot, file))
        : file;
    const originalRead = jsonIo.readJsonIfPresent;
    const originalWrite = jsonIo.writeJson;
    const originalMkdir = secureIo.safeMkdir;
    const originalRequest = activationApproval.requestTenantActivationApproval;
    const originalApply = activationApproval.applyApprovedTenantActivation;
    const originalActivation = activation.loadTenantActivation;
    vi.spyOn(jsonIo, 'readJsonIfPresent').mockImplementation((file, options) =>
      originalRead(remap(file), options)
    );
    vi.spyOn(jsonIo, 'writeJson').mockImplementation((file, value) =>
      originalWrite(remap(file), value)
    );
    vi.spyOn(secureIo, 'safeMkdir').mockImplementation((file, options) =>
      originalMkdir(remap(file), options)
    );
    vi.spyOn(activationApproval, 'requestTenantActivationApproval').mockImplementation(
      (a, command, who) => originalRequest(a, command, who, { rootDir: fixture.rootDir })
    );
    vi.spyOn(activationApproval, 'applyApprovedTenantActivation').mockImplementation(
      (a, command, who) => originalApply(a, command, who, { rootDir: fixture.rootDir })
    );
    vi.spyOn(activation, 'loadTenantActivation').mockImplementation((target, root) =>
      originalActivation(target, root ?? fixture.rootDir)
    );
    vi.spyOn(tenantRegistry, 'readTenantProfile').mockImplementation((slug, options) =>
      originalReadTenant(slug, { rootDir: fixture.rootDir, ...options })
    );
    vi.spyOn(onboarding, 'loadOnboardingContextBinding').mockImplementation((slug, root) =>
      originalReadBinding(slug, root ?? fixture.rootDir)
    );
    vi.spyOn(companyBootstrap, 'listCompanyVerticals').mockReturnValue(['saas-product-company']);
    const companyAuth = { ...auth, tenantSlug: companyTenant };
    const companyPrincipal = { ...principal, tenantSlugs: [companyTenant] };
    const requested = await executeCompanySetup(
      companyAuth,
      { action: 'request_activation' },
      companyPrincipal
    );
    if (!('setup' in requested)) throw new Error('Expected workflow setup.');
    const id = requested.setup.activationApproval!.id;
    approvalIds.push(id);
    const record = loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, id)!;
    expect(record.status).toBe('pending');
    expect(record.scope?.tier).toBe('confidential');
    decide(record, { deciderPrincipal: companyPrincipal });
    const applied = await executeCompanySetup(
      companyAuth,
      { action: 'apply_activation', requestId: id },
      companyPrincipal
    );
    if (!('setup' in applied)) throw new Error('Expected workflow setup.');
    expect(applied.setup.stage).toBe('active');
    expect(loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, id)?.applyResult?.result).toBe(
      'success'
    );
  });
  it('rejects missing displayed digest even when assurance rollout is warn', async () => {
    const record = await request();
    expect(() =>
      decide(record, {
        presentedDigest: undefined,
        payloadHash: record.accountability?.payloadHash,
        effectBinding: record.accountability?.effectBinding,
      })
    ).toThrow(/without the digest/);
    expect(loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.status).toBe(
      'pending'
    );
  });
  it('rejects agents, unknown and below-A2 proofs, including recheck in warn mode', async () => {
    const record = await request();
    expect(() => decide(record, { decidedByType: 'ai_agent' })).toThrow(/human/);
    expect(() =>
      decide(record, {
        deciderPrincipal: {
          ...principal,
          actor: { kind: 'agent', id: nhiIds[0] },
          source: 'agent',
        },
      })
    ).toThrow(/agent/);
    for (const method of ['manual', 'channel_identity', 'invented']) {
      expect(() => decide(record, { authMethod: method })).toThrow(/assurance|recognised/);
      expect(() =>
        validateHumanFinalDecision({
          accountability: record.accountability,
          decidedByType: 'human',
          authenticated: true,
          authMethod: method as 'manual',
          payloadHash: record.accountability?.payloadHash,
          effectBinding: record.accountability?.effectBinding,
          phase: 'recheck',
          mode: 'warn',
        })
      ).toThrow(/assurance|recognised/);
    }
    await expect(
      context(() =>
        requestTenantActivationApproval(
          auth,
          input,
          { ...principal, provider: 'loopback-local' },
          { rootDir: fixture.rootDir }
        )
      )
    ).rejects.toThrow(/A2/);
  });
  it.each([
    { tier: 'public' },
    { tenant_slug: 'other-tenant' },
    { organization_id: 'org-other' },
    { nhi_ids: ['kyberion://agent/org-test/other'] },
    {
      created_at: new Date(
        Date.now() - TENANT_ACTIVATION_EVIDENCE_MAX_AGE_MS - 60000
      ).toISOString(),
    },
    { created_at: new Date(Date.now() + 3600000).toISOString() },
  ])('refuses wrong-scope or stale/future structured evidence: %j', async (patch) => {
    changeEvidence(patch);
    await expect(request()).rejects.toThrow(/probe|Probe/);
  });
  it('rejects external attestations and client owner/check injection', async () => {
    input.evidenceRef = 'probe://external/evidence';
    await expect(request()).rejects.toThrow();
    input.evidenceRef = path.relative(fixture.rootDir, evidenceFile);
    await expect(
      context(() =>
        requestTenantActivationApproval(
          auth,
          { ...input, ownerId: 'human:attacker' } as typeof input,
          principal,
          { rootDir: fixture.rootDir }
        )
      )
    ).rejects.toThrow();
  });
  it('invalidates approval when the binding, evidence bytes, NHI or services change', async () => {
    const record = await request();
    decide(record);
    changeEvidence({ unused: 'changed after presentation' });
    await expect(apply(record)).rejects.toThrow(/state changed/);
    expect(
      loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.applyClaim
    ).toBeUndefined();
  });
  it('rechecks viewer scope at request and apply, binding changes to a fresh review', async () => {
    const record = await request();
    decide(record);
    vi.stubEnv('KYBERION_VIEWER_SCOPE', 'off');
    await expect(apply(record)).rejects.toThrow(/Viewer scope/);
    await expect(request()).rejects.toThrow(/Viewer scope/);
    vi.stubEnv('KYBERION_VIEWER_SCOPE', 'enforce');
    await expect(apply(record)).rejects.toThrow(/state changed/);
    expect(
      loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.applyClaim
    ).toBeUndefined();
  });
  it.each(['nhi', 'binding'] as const)(
    'refuses %s changes while service preflight is awaited',
    async (target) => {
      const record = await request();
      decide(record);
      fixture.onPreflight = async () => {
        await Promise.resolve();
        if (target === 'nhi') fixture.lifecycle = 'suspended';
        else
          modify(() => {
            const file = path.join(
              fixture.rootDir,
              'customer',
              scope.customerSlug,
              'onboarding/organization-context.json'
            );
            writeJson(file, {
              ...readJson<Record<string, unknown>>(file),
              owner_id: 'human:other-owner',
            });
          });
      };
      await expect(apply(record)).rejects.toThrow(/NHI|binding|owner changed/);
      expect(
        loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.applyClaim
      ).toBeUndefined();
    }
  );
  it('rejects current owner revocation and a revoked NHI before apply', async () => {
    const record = await request();
    decide(record);
    fixture.lifecycle = 'suspended';
    await expect(apply(record)).rejects.toThrow(/NHI/);
    fixture.lifecycle = 'active';
    modify(() => {
      const owner = readMemberProfile(auth.memberId, { rootDir: fixture.rootDir })!;
      writeMemberProfile({ ...owner, memberships: [] }, { rootDir: fixture.rootDir });
    });
    await expect(apply(record)).rejects.toThrow(/owner membership/);
  });
  it('rejects current weak/expired auth, missing durable presentation and service loss', async () => {
    const record = await request();
    const approved = decide(record);
    await expect(
      apply(record, { ...principal, expiresAt: new Date(Date.now() - 1).toISOString() })
    ).rejects.toThrow(/expired/);
    await expect(apply(record, { ...principal, provider: 'loopback-local' })).rejects.toThrow(/A2/);
    fixture.serviceReady = false;
    await expect(apply(record)).rejects.toThrow(/service/);
    fixture.serviceReady = true;
    replaceRecord({ ...approved, verifiedPresentedDigest: undefined });
    await expect(apply(record)).rejects.toThrow(/presented decision/);
  });
  it('refuses old weak/unknown approval proofs even with a durable presentation marker', async () => {
    const record = await request();
    const approved = decide(record);
    replaceRecord({
      ...approved,
      accountability: { ...approved.accountability!, min_assurance: 'A0' },
      decidedAuthMethod: 'manual',
    });
    expect(() =>
      validateHumanFinalDecision({
        accountability: { ...approved.accountability!, min_assurance: 'A0' },
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'manual',
        phase: 'recheck',
        mode: 'warn',
      })
    ).toThrow(/assurance A2/);
    for (const method of ['manual', 'invented', undefined]) {
      replaceRecord({ ...approved, decidedAuthMethod: method as 'manual' });
      await expect(apply(record)).rejects.toThrow(/assurance|recognised/);
    }
  });
  it('records a failed application and never retries its consumed claim', async () => {
    const record = await request();
    decide(record);
    const effect = vi.spyOn(activation, 'applyTenantActivation').mockImplementation(() => {
      throw new Error('synthetic write failure');
    });
    await expect(apply(record)).rejects.toThrow(/synthetic write failure/);
    expect(
      loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.applyResult?.result
    ).toBe('failed');
    await expect(apply(record)).rejects.toThrow(/unused/);
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it('rejects payload changes and an approval revocation racing the apply claim', async () => {
    const record = await request();
    const approved = decide(record);
    const payload = JSON.parse(approved.sourceText!);
    payload.command.serviceIds = [];
    replaceRecord({ ...approved, sourceText: JSON.stringify(payload) });
    await expect(apply(record)).rejects.toThrow(/presented decision/);
    replaceRecord(approved);
    const original = store.claimApprovalApply;
    vi.spyOn(store, 'claimApprovalApply').mockImplementation((role, params) => {
      const latest = loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)!;
      replaceRecord({
        ...latest,
        revocation: {
          revokedAt: new Date().toISOString(),
          revokedBy: auth.actorId,
          reason: 'synthetic race',
        },
      });
      return original(role, params);
    });
    await expect(apply(record)).rejects.toThrow(/changed before apply/);
    expect(
      loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, record.id)?.applyClaim
    ).toBeUndefined();
    expect(computeApprovalPayloadHash({ record: approved })).not.toBe('');
  });
});
