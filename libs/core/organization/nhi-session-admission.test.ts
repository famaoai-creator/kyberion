/** NHI session-admission ceremony + org-scope consumption. */
import { expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';

const f = useOnboardingAuthorityFixture();

const ORG_TENANT = 'fixture-a';
const SCOPE = { kind: 'organization' as const, tenant_slug: ORG_TENANT };

function installOrgAgent() {
  return f.governIdentity(() =>
    f.identities.issueAgentIdentity({
      kind: 'agent',
      slug: 'org-agent',
      organizationId: ORG_TENANT,
      displayName: 'Synthetic org agent',
      accountableHumanId: 'user:owner',
    })
  );
}

async function admissionApi() {
  return import('./nhi-session-admission.js');
}
async function runtimeIdentity() {
  return import('./onboarding-runtime-identity.js');
}

function claimSession(nhiId?: string, session?: string) {
  vi.stubEnv('KYBERION_NHI_ACTOR', nhiId ?? '');
  vi.stubEnv('KYBERION_NHI_SESSION', session ?? '');
}

/** Same human decision path as the fixture, on the admission channel. */
function approveAdmission(channel: string, requestId: string) {
  f.run(() => {
    const record = f.approvals.loadApprovalRequest(channel, requestId)!;
    return f.approvals.decideApprovalRequest('mission_controller', {
      channel: record.channel,
      requestId,
      decision: 'approved',
      decidedBy: f.viewer.principal.actor.id,
      decidedByRole: 'owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderPrincipal: f.viewer.principal,
      presentedDigest: f.approvals.computeApprovalPresentedDigest(record),
      payloadHash: record.accountability?.payloadHash,
      effectBinding: record.accountability?.effectBinding,
    });
  });
}

it('runs request → human approval → apply, and the admitted session satisfies org runtime inspection', async () => {
  const agent = installOrgAgent();
  const api = await admissionApi();
  const inspect = await runtimeIdentity();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };

  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  expect(request.ok).toBe(true);
  const record = f.run(() =>
    f.approvals.loadApprovalRequest(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id)
  );
  expect(record?.accountability?.finalDecision).toBe('human_only');
  expect(record?.scope).toMatchObject({ tier: 'confidential', tenant_slug: ORG_TENANT });

  // Applying before the human decision fails closed.
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow(/accountable human required/);

  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );
  expect(applied.ok).toBe(true);
  expect(applied.session_id).toMatch(/^kns1\./);
  // A provisioned identity is activated by its first instance binding.
  expect(applied.lifecycle_status).toBe('active');

  // The session env pair admits org-scope delegation; bare env does not.
  const live = (nhi?: string, session?: string) => {
    claimSession(nhi, session);
    try {
      return f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE));
    } finally {
      claimSession();
    }
  };
  expect(live()).toMatchObject({ ready: false, reason: 'session_admission_required' });
  expect(live(agent.nhi_id)).toMatchObject({
    ready: false,
    reason: 'session_admission_required',
  });
  expect(live(agent.nhi_id, 'kns1.forged')).toMatchObject({
    ready: false,
    reason: 'session_admission_required',
  });
  expect(live(agent.nhi_id, applied.session_id)).toMatchObject({
    ready: true,
    agentId: agent.nhi_id,
    agentActive: true,
    ownerId: 'user:owner',
  });
});

it('refuses env-only claims for other tenants and unregistered NHIs', async () => {
  const agent = installOrgAgent();
  const api = await admissionApi();
  const inspect = await runtimeIdentity();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );

  claimSession(agent.nhi_id, applied.session_id);
  // Same session, different tenant → the binding's approved tenant scope
  // fails closed (session_admission_required), before affiliation matters.
  expect(
    f.run(() =>
      inspect.inspectInstalledOnboardingRuntime({ kind: 'organization', tenant_slug: 'fixture-b' })
    )
  ).toMatchObject({ ready: false, reason: 'session_admission_required' });
  // Unregistered NHI claim → not admitted even with a real session token.
  claimSession('kyberion://agent/fixture-a/unknown-agent', applied.session_id);
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: false,
  });
  claimSession();
});

it('rejects an NHI accountable to a different human and non-owner requesters', async () => {
  const api = await admissionApi();
  const foreign = f.governIdentity(() =>
    f.identities.issueAgentIdentity({
      kind: 'agent',
      slug: 'foreign-agent',
      organizationId: ORG_TENANT,
      displayName: 'Accountable elsewhere',
      accountableHumanId: 'user:someone-else',
    })
  );
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  expect(() =>
    f.run(() =>
      api.requestNhiSessionAdmission(principal, {
        nhi_id: foreign.nhi_id,
        tenant_slug: ORG_TENANT,
      })
    )
  ).toThrow(/accountable human differs/);
  expect(() =>
    f.run(() =>
      api.requestNhiSessionAdmission(
        { ...principal, tenantSlugs: [] as string[] },
        { nhi_id: foreign.nhi_id, tenant_slug: ORG_TENANT }
      )
    )
  ).toThrow(/tenant owner required/);
});

it('expires bindings and revokes them through the journal', async () => {
  const agent = installOrgAgent();
  const api = await admissionApi();
  const inspect = await runtimeIdentity();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, {
      nhi_id: agent.nhi_id,
      tenant_slug: ORG_TENANT,
      ttl_seconds: 60,
    })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );

  // Expired binding is not live.
  const past = api.findLiveSessionAdmission(
    agent.nhi_id,
    applied.session_id,
    new Date(Date.now() + 120_000)
  );
  expect(past).toBeUndefined();

  // Revocation removes the binding → inspection fails closed again.
  const list = f.run(() => api.listNhiSessionAdmissions({ tenant_slug: ORG_TENANT }));
  expect(list.some((entry) => entry.instance.instance_id === applied.instance_id)).toBe(true);
  f.run(() =>
    api.revokeNhiSessionAdmission(principal, {
      nhi_id: agent.nhi_id,
      tenant_slug: ORG_TENANT,
      instance_id: applied.instance_id,
    })
  );
  claimSession(agent.nhi_id, applied.session_id);
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: false,
    reason: 'session_admission_required',
  });
  claimSession();
});

it('suspension kills session bindings and reactivation does not resurrect them', async () => {
  const agent = installOrgAgent();
  const api = await admissionApi();
  const inspect = await runtimeIdentity();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );
  claimSession(agent.nhi_id, applied.session_id);
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: true,
  });
  f.governIdentity(() => f.identities.suspendAgentIdentity(agent.nhi_id));
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: false,
  });
  // Reactivation does not restore the pre-incident session token.
  f.governIdentity(() => f.identities.activateAgentIdentity(agent.nhi_id));
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: false,
    reason: 'session_admission_required',
  });
  claimSession();
});

it('keeps the person-scope profile path unchanged', async () => {
  const inspect = await runtimeIdentity();
  // The fixture installs a profile agent identity (default org) — person scope
  // must still resolve it without any session env.
  claimSession();
  const result = f.run(() => inspect.inspectInstalledOnboardingRuntime({ kind: 'person' }));
  expect(result).toMatchObject({ ready: true, agentActive: true });
});
