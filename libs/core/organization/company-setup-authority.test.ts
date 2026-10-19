/** Production Concierge authority contract, with only synthetic identities and isolated journals. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSystemRoleLaunchEnv,
  DELEGATED_ROLE_ENV,
  isRoleAssumptionAllowed,
  resolveRole,
  withExecutionContext,
  resetRoleAssumptionPolicyCache,
} from '../authority.js';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import type { SurfaceManagementAuthorization } from '../surface/surface-management-contract.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { writeTenantProfile, tenantProfilePath } from './tenant-registry.js';
import { writeMemberProfile, memberProfilePath } from './member-registry.js';
import { getAgentIdentity, resetAgentIdentityServiceForTests } from '../agent/agent-identity.js';
import {
  setWorkCoordinationNamespace,
  clearWorkCoordinationNamespace,
  getWorkItem,
} from '../workforce/work-coordination.js';
import { executeCompanySetup } from './company-setup-workflow.js';
import { loadOnboardingFirstWorkRecord } from './onboarding-context.js';
import { loadTenantActivation } from './tenant-activation.js';
import {
  buildProjectBootstrapWorkItems,
  loadProjectRecord,
  projectRecordPath,
} from '../project/project-registry.js';
import { missionSeedRecordPath } from '../mission/mission-seed-registry.js';
import { taskSessionPath } from '../task/task-session.js';
import {
  VITEST_APPROVAL_STORE_ROOT,
  loadApprovalRequest,
  computeApprovalPresentedDigest,
  decideApprovalRequest,
} from '../governance/approval-store.js';
import { TENANT_ACTIVATION_APPROVAL_CHANNEL } from './tenant-activation-approval.js';

const firstWorkIntent =
  '会議準備チェックリストの文書を作る新規プロジェクト。提出期限と担当者、遅れた場合の連絡先を含め、レビューを受けて改訂する。';
let tenant: string;
let member: string;
let scratch: string;
let projectId: string;
let owned: string[] = [];
let auth: SurfaceManagementAuthorization;
let principal: ResolvedPrincipal;
function owner<T>(fn: () => T): T {
  return withExecutionContext('sovereign_concierge', fn, undefined, tenant, tenant);
}
function reserve(file: string): void {
  if (safeExistsSync(file)) throw new Error('Refusing existing integration fixture path: ' + file);
  owned.push(file);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
  const launched = buildSystemRoleLaunchEnv({}, 'concierge');
  for (const key of ['SYSTEM_ROLE', 'MISSION_ROLE', 'KYBERION_PERSONA', DELEGATED_ROLE_ENV])
    vi.stubEnv(key, launched[key] ?? '');
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('KYBERION_CUSTOMER', '');
  vi.stubEnv('KYBERION_VIEWER_SCOPE', 'enforce');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  resetRoleAssumptionPolicyCache();
  const suffix = randomUUID().slice(0, 8);
  tenant = 'web-auth-' + suffix;
  // Documented Vitest store seam: this fixture cannot share another run's approvals.
  vi.stubEnv(
    'KYBERION_VITEST_RUN_ID',
    (process.env.KYBERION_VITEST_RUN_ID ?? 'isolated') + '-' + tenant
  );
  member = 'web-owner-' + suffix;
  projectId = 'PRJ-' + tenant.toUpperCase() + '-FIRST';
  scratch = path.join(pathResolver.rootDir(), 'active/shared/tmp', tenant);
  owned = [];
  owner(() => {
    for (const target of [
      scratch,
      tenantProfilePath(tenant),
      memberProfilePath(member),
      projectRecordPath(projectId),
      pathResolver.rootResolve('customer/' + tenant),
      pathResolver.rootResolve('knowledge/confidential/' + tenant),
      pathResolver.rootResolve('active/organizations/confidential/' + tenant),
      pathResolver.rootResolve('active/projects/confidential/' + tenant),
      pathResolver.shared('runtime/work-coordination/' + tenant),
      pathResolver.shared('observability/work-coordination/' + tenant),
    ])
      reserve(target);
    for (const work of buildProjectBootstrapWorkItems({
      projectId,
      projectName: firstWorkIntent,
      utterance: firstWorkIntent,
    })) {
      const suffix = work.work_id.replace(/^WRK-/, '');
      reserve(
        work.kind === 'mission_seed'
          ? missionSeedRecordPath('MSD-' + suffix)
          : taskSessionPath('TSK-' + suffix)
      );
    }
    const runId = process.env.KYBERION_VITEST_RUN_ID?.replace(/[^\w-]/g, '');
    if (!runId || !runId.endsWith(tenant)) throw new Error('Missing unique fixture run ID');
    reserve(pathResolver.rootResolve(path.join(VITEST_APPROVAL_STORE_ROOT, 'run-' + runId)));
    safeMkdir(scratch, { recursive: true });
    writeTenantProfile({
      tenant_slug: tenant,
      tenant_id: tenant,
      display_name: 'Synthetic Authority Company',
      status: 'active',
      assigned_role: 'customer',
      isolation_policy: { strict_isolation: true, allow_cross_distillation: false },
    });
    const now = new Date().toISOString();
    writeMemberProfile({
      member_id: member,
      display_name: 'Synthetic Owner',
      status: 'active',
      memberships: [{ tenant_slug: tenant, role: 'owner' }],
      access_registrations: [],
      created_at: now,
      updated_at: now,
    });
  });
  resetAgentIdentityServiceForTests(path.join(scratch, 'nhi-identities.jsonl'));
  setWorkCoordinationNamespace(tenant);
  auth = {
    actorId: 'user:' + member,
    memberId: member,
    tenantSlug: tenant,
    allowedOrganizationIds: 'all',
    allowedProjectIds: 'all',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
  principal = {
    actor: { kind: 'human', id: auth.actorId },
    memberId: member,
    principalId: auth.actorId,
    provider: 'browser-session',
    source: 'token',
    assurance: 'high',
    role: 'owner',
    tenantSlugs: [tenant],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential'],
    expiresAt: auth.expiresAt,
  };
});
afterEach(() => {
  // Every path was checked absent before fixture creation. Never sweep a shared parent.
  try {
    owner(() => {
      for (const target of owned.reverse()) safeRmSync(target, { recursive: true, force: true });
    });
  } finally {
    owned = [];
    resetAgentIdentityServiceForTests();
    clearWorkCoordinationNamespace();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetRoleAssumptionPolicyCache();
  }
});

describe('real Concierge company setup authority', () => {
  it('registers, probes, obtains exact human approval, activates and prepares first work under unchanged production roles', async () => {
    expect(resolveRole()).toBe('concierge');
    expect(process.env.KYBERION_SUDO).toBe('false');
    expect(process.env.MISSION_ROLE).toBeFalsy();
    expect(process.env.KYBERION_PERSONA).toBeFalsy();
    expect(isRoleAssumptionAllowed('concierge', 'check_tenant_registry_consistency')).toBe(false);
    expect(() =>
      withExecutionContext('check_tenant_registry_consistency', () => undefined)
    ).toThrow(/ROLE_ASSUMPTION_DENIED/);
    const input = {
      vertical: 'saas-product-company',
      firstWork: firstWorkIntent,
    };
    const preview = await executeCompanySetup(
      auth,
      { action: 'preview_company', ...input },
      principal
    );
    if (!('review' in preview)) throw new Error('Expected company review');
    const registered = await executeCompanySetup(
      auth,
      { action: 'register_company', ...input, reviewDigest: preview.review.digest },
      principal
    );
    if (!('setup' in registered)) throw new Error('Expected registration result');
    expect(registered.setup.stage).toBe('registered');
    expect(
      owner(() => getAgentIdentity('kyberion://agent/' + tenant + '/ceo-operator'))
    ).toMatchObject({
      accountable_human_id: 'human:' + member,
      affiliation: { organization_id: tenant, tenant_slug: tenant },
    });
    const probed = await executeCompanySetup(auth, { action: 'probe' }, principal);
    if (!('setup' in probed)) throw new Error('Expected probe result');
    expect(probed.setup.probePassed, probed.setup.probeSummary.join('; ')).toBe(true);
    const requested = await executeCompanySetup(auth, { action: 'request_activation' }, principal);
    if (!('setup' in requested)) throw new Error('Expected activation request');
    const requestId = requested.setup.activationApproval!.id;
    owner(() => {
      const pending = loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, requestId)!;
      expect(pending.status).toBe('pending');
      decideApprovalRequest('mission_controller', {
        channel: pending.channel,
        requestId,
        decision: 'approved',
        decidedBy: auth.actorId,
        decidedByType: 'human',
        deciderIdentitySource: 'server_resolved',
        authenticated: true,
        authMethod: 'surface_session',
        deciderPrincipal: principal,
        presentedDigest: computeApprovalPresentedDigest(pending),
      });
    });
    const activated = await executeCompanySetup(
      auth,
      { action: 'apply_activation', requestId },
      principal
    );
    if (!('setup' in activated)) throw new Error('Expected activation result');
    expect(activated.setup.stage).toBe('active');
    expect(
      owner(() =>
        loadTenantActivation({ customerSlug: tenant, tenantSlug: tenant, organizationId: tenant })
      )
    ).toMatchObject({ status: 'active' });
    const firstPreview = await executeCompanySetup(
      auth,
      { action: 'preview_first_work' },
      principal
    );
    if (!('review' in firstPreview)) throw new Error('Expected first-work review');
    expect(firstPreview.review.summary).toContain('Work shape: solution_project');
    expect(firstPreview.review.summary).toContain(input.firstWork);
    const prepared = await executeCompanySetup(
      auth,
      { action: 'apply_first_work', reviewDigest: firstPreview.review.digest },
      principal
    );
    if (!('setup' in prepared)) throw new Error('Expected first-work result');
    expect(prepared.setup.stage).toBe('first_work_prepared');
    expect(prepared.setup.execution).toBe('not_started');
    owner(() => {
      const first = loadOnboardingFirstWorkRecord(tenant)!;
      expect(first).toMatchObject({
        tenant_slug: tenant,
        organization_id: tenant,
        tier: 'confidential',
        management_unit_id: projectId,
        management_unit: 'project',
        work_shape: 'solution_project',
        intent: input.firstWork,
      });
      expect(loadProjectRecord(projectId)).toMatchObject({
        tenant_slug: tenant,
        organization_id: tenant,
        tier: 'confidential',
        status: 'active',
      });
      expect(getWorkItem(first.work_item_id!)?.context).toMatchObject({
        tenant_slug: tenant,
        organization_id: tenant,
        project_id: projectId,
      });
      expect(
        loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, requestId)?.applyResult?.result
      ).toBe('success');
    });
    expect(resolveRole()).toBe('concierge');
    expect(process.env.MISSION_ROLE).toBeFalsy();
    expect(process.env.KYBERION_PERSONA).toBeFalsy();
  });
});
