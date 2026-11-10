/** NHI session-admission ceremony + org-scope consumption. */
import { afterEach, expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
import { safeWriteFile, safeAppendFileSync } from '../secure-io.js';

const f = useOnboardingAuthorityFixture();
afterEach(() => vi.restoreAllMocks());

const ORG_TENANT = 'fixture-a';
const SCOPE = { kind: 'organization' as const, tenant_slug: ORG_TENANT };

function installOrgAgent() {
  return f.governIdentity(() =>
    f.identities.issueAgentIdentity({
      kind: 'agent',
      slug: 'org-agent',
      organizationId: ORG_TENANT,
      affiliation: { tenant_slug: ORG_TENANT },
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

async function approvedAdmission() {
  const agent = installOrgAgent();
  const api = await admissionApi();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  return { agent, api, principal, request };
}

it('requires fresh approval after suspension and reactivation, even if the NHI looks active again', async () => {
  const { agent, api, principal, request } = await approvedAdmission();
  f.governIdentity(() => {
    f.identities.suspendAgentIdentity(agent.nhi_id, 'incident');
    f.identities.activateAgentIdentity(agent.nhi_id);
  });
  expect(
    f.run(() => api.nhiSessionAdmissionStatus(principal, ORG_TENANT, request.request_id)).can_apply
  ).toBe(false);
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow('NHI changed since request');
  expect(f.identities.getAgentIdentity(agent.nhi_id)?.runtime_instances).toBeUndefined();
  const fresh = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, fresh.request_id);
  expect(
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, fresh.request_id)).ok
  ).toBe(true);
});

it('rejects a legacy approved plan without inventing its identity revision', async () => {
  const approvals = await import('../governance/approval-store.js');
  const original = approvals.createApprovalRequest;
  vi.spyOn(approvals, 'createApprovalRequest').mockImplementationOnce((role, params) => {
    const legacy = JSON.parse(params.sourceText!);
    delete legacy.identity_revision;
    const digest = approvals.computeApprovalPayloadHash({ value: legacy });
    return original(role, {
      ...params,
      sourceText: JSON.stringify(legacy),
      accountability: { ...params.accountability!, payloadHash: digest, effectBinding: digest },
    });
  });
  const { agent, api, principal, request } = await approvedAdmission();
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow('NHI changed since request');
  expect(f.identities.getAgentIdentity(agent.nhi_id)?.runtime_instances).toBeUndefined();
});

it('rejects an approval across an accountability transfer and transfer back', async () => {
  const { agent, api, principal, request } = await approvedAdmission();
  f.governIdentity(() => {
    f.identities.reassignAgentIdentityAccountability({
      nhiId: agent.nhi_id,
      expectedAccountableHumanId: 'user:owner',
      accountableHumanId: 'user:other',
      reason: 'transfer',
    });
    f.identities.reassignAgentIdentityAccountability({
      nhiId: agent.nhi_id,
      expectedAccountableHumanId: 'user:other',
      accountableHumanId: 'user:owner',
      reason: 'transfer back',
    });
  });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow('NHI changed since request');
});

it('fences a suspend/reactivate after the approval claim but before the bind', async () => {
  const { agent, api, principal, request } = await approvedAdmission();
  const claims = await import('../governance/approval-apply-claim.js');
  const original = claims.claimApprovalApply;
  vi.spyOn(claims, 'claimApprovalApply').mockImplementationOnce((...args) => {
    const claimed = original(...args);
    f.governIdentity(() => {
      f.identities.suspendAgentIdentity(agent.nhi_id, 'incident');
      f.identities.activateAgentIdentity(agent.nhi_id);
    });
    return claimed;
  });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow('identity changed before binding');
  expect(f.identities.getAgentIdentity(agent.nhi_id)?.runtime_instances).toBeUndefined();
  const record = f.run(() =>
    f.approvals.loadApprovalRequest(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id)
  );
  expect(record?.applyClaim).toBeDefined();
  expect(record?.applyResult).toBeUndefined();
});

it.each([
  'result-write-fails',
  'result-write-uncertain',
  'suspend-reactivate',
  'accountability-transfer-back',
] as const)('does not return or retain a session when %s after binding', async (interruption) => {
  const { agent, api, principal, request } = await approvedAdmission();
  const approvals = await import('../governance/approval-store.js');
  const original = approvals.recordApprovalApplyResult;
  vi.spyOn(approvals, 'recordApprovalApplyResult').mockImplementationOnce((...args) => {
    if (interruption === 'result-write-fails') throw new Error('synthetic result write failure');
    if (interruption === 'result-write-uncertain') {
      original(...args);
      throw new Error('synthetic result write uncertain');
    }
    f.governIdentity(() => {
      if (interruption === 'accountability-transfer-back') {
        f.identities.reassignAgentIdentityAccountability({
          nhiId: agent.nhi_id,
          expectedAccountableHumanId: 'user:owner',
          accountableHumanId: 'user:other',
          reason: 'transfer',
        });
        f.identities.reassignAgentIdentityAccountability({
          nhiId: agent.nhi_id,
          expectedAccountableHumanId: 'user:other',
          accountableHumanId: 'user:owner',
          reason: 'transfer back',
        });
      } else {
        f.identities.suspendAgentIdentity(agent.nhi_id, 'incident');
        f.identities.activateAgentIdentity(agent.nhi_id);
      }
    });
    return original(...args);
  });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow(
    interruption.startsWith('result-write') ? 'synthetic result write' : 'session binding stopped'
  );
  expect(f.identities.getAgentIdentity(agent.nhi_id)?.runtime_instances).toBeUndefined();
  expect(
    f.run(() => api.nhiSessionAdmissionStatus(principal, ORG_TENANT, request.request_id))
  ).toMatchObject({ status: 'reconciliation_required', can_apply: false });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow();
});

it('compensates a binding that was appended before the bind call threw', async () => {
  const { agent, api, principal, request } = await approvedAdmission();
  const original = f.identities.bindRuntimeInstance;
  vi.spyOn(f.identities, 'bindRuntimeInstance').mockImplementationOnce((params) => {
    original(params);
    throw new Error('synthetic post-append failure');
  });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow('synthetic post-append failure');
  expect(f.identities.getAgentIdentity(agent.nhi_id)?.runtime_instances).toBeUndefined();
  expect(
    f.run(() => api.nhiSessionAdmissionStatus(principal, ORG_TENANT, request.request_id))
  ).toMatchObject({ status: 'reconciliation_required', can_apply: false });
});

it('preserves both errors and the reconciliation claim when compensation cannot be persisted', async () => {
  const { api, principal, request } = await approvedAdmission();
  const original = f.identities.bindRuntimeInstance;
  vi.spyOn(f.identities, 'bindRuntimeInstance').mockImplementationOnce((params) => {
    original(params);
    throw new Error('synthetic post-append failure');
  });
  vi.spyOn(f.identities, 'releaseRuntimeInstance').mockImplementationOnce(() => {
    throw new Error('synthetic cleanup failure');
  });
  expect(() =>
    f.run(() => api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id))
  ).toThrow(
    expect.objectContaining({
      message: expect.stringContaining('reconciliation required'),
      errors: [
        expect.objectContaining({ message: 'synthetic post-append failure' }),
        expect.objectContaining({ message: 'synthetic cleanup failure' }),
      ],
    })
  );
  expect(
    f.run(() => api.nhiSessionAdmissionStatus(principal, ORG_TENANT, request.request_id))
  ).toMatchObject({ status: 'reconciliation_required', can_apply: false });
});

function claimSession(nhiId?: string, session?: string) {
  vi.stubEnv('KYBERION_NHI_ID', nhiId);
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
  expect(
    f.run(() => api.nhiSessionAdmissionStatus(principal, ORG_TENANT, request.request_id))
  ).toMatchObject({ status: 'applied', can_apply: false });

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
    runtimeBindingHistory: {
      status: 'available',
      assurance: 'metadata_only',
      reference: { version: 1, nhi_id: agent.nhi_id },
    },
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
      tenantSlug: ORG_TENANT,
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
  expect(api.findLiveSessionAdmission(agent.nhi_id, applied.session_id, ORG_TENANT)).toMatchObject({
    instance_id: applied.instance_id,
  });
  const past = api.findLiveSessionAdmission(
    agent.nhi_id,
    applied.session_id,
    ORG_TENANT,
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
  expect(result).not.toHaveProperty('runtimeBindingHistory');
});

it('reports strict binding history unavailable without breaking legacy live admission', async () => {
  const { agent, api, principal, request } = await approvedAdmission();
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );
  const inspect = await runtimeIdentity();
  claimSession(agent.nhi_id, applied.session_id);
  const initial = f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE));
  expect(initial).toMatchObject({ ready: true, runtimeBindingHistory: { status: 'available' } });
  expect(JSON.stringify(initial)).not.toContain(applied.session_id);
  f.run(() => safeAppendFileSync(f.identities.agentIdentityJournalResourcePath(), '{broken\n'));
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: true,
    runtimeBindingHistory: { status: 'unavailable' },
  });
  claimSession();
});

it('does not infer tenant affiliation from an organization name or override a foreign tenant', async () => {
  const api = await admissionApi();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  for (const [slug, tenant] of [
    ['legacy-agent', undefined],
    ['foreign-agent', 'fixture-b'],
  ] as const) {
    const agent = f.governIdentity(() =>
      f.identities.issueAgentIdentity({
        kind: 'agent',
        slug,
        // No tenant: a tenantless identity (D3 `_/_`) — never inferred from an org name.
        ...(tenant
          ? { organizationId: ORG_TENANT, affiliation: { tenant_slug: tenant } }
          : { personScope: true }),
        accountableHumanId: 'user:owner',
      })
    );
    expect(() =>
      f.run(() =>
        api.requestNhiSessionAdmission(principal, {
          nhi_id: agent.nhi_id,
          tenant_slug: ORG_TENANT,
        })
      )
    ).toThrow(/not affiliated/);
  }
});

it('preserves policy mode while selecting an explicit identity and supports legacy URI claims', async () => {
  const api = await admissionApi();
  const agent = installOrgAgent();
  vi.stubEnv('KYBERION_NHI_ACTOR', 'enforce');
  claimSession(agent.nhi_id);
  expect(api.claimedNhiIdentity()).toBe(agent.nhi_id);
  expect(process.env.KYBERION_NHI_ACTOR).toBe('enforce');
  claimSession();
  expect(api.claimedNhiIdentity()).toBeUndefined();
  vi.stubEnv('KYBERION_NHI_ACTOR', agent.nhi_id);
  expect(api.claimedNhiIdentity()).toBe(agent.nhi_id);
  vi.stubEnv('KYBERION_NHI_ID', 'invalid');
  expect(api.claimedNhiIdentity()).toBeUndefined();
  vi.stubEnv('KYBERION_NHI_ID', '');
  expect(api.claimedNhiIdentity()).toBeUndefined();
});

it('consumes an attested legacy session only in its approved tenant, never through org-name inference', async () => {
  const api = await admissionApi();
  const legacy = f.governIdentity(() =>
    f.identities.issueAgentIdentity({
      kind: 'agent',
      slug: 'legacy-bound',
      personScope: true,
      accountableHumanId: 'user:owner',
    })
  );
  f.governIdentity(() =>
    f.identities.bindRuntimeInstance({
      nhiId: legacy.nhi_id,
      instanceId: `${api.ADMISSION_INSTANCE_PREFIX}legacy`,
      sessionId: 'kns1.legacy-fixture',
      tenantSlug: ORG_TENANT,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    })
  );
  expect(
    api.findLiveSessionAdmission(legacy.nhi_id, 'kns1.legacy-fixture', ORG_TENANT)
  ).toBeDefined();
  expect(
    api.findLiveSessionAdmission(legacy.nhi_id, 'kns1.legacy-fixture', 'fixture-b')
  ).toBeUndefined();
  expect(api.listNhiSessionAdmissions({ tenant_slug: 'fixture-b' })).toHaveLength(0);
});

it('does not ignore a malformed profile when consuming an otherwise valid tenant admission', async () => {
  const api = await admissionApi();
  const inspect = await runtimeIdentity();
  const agent = installOrgAgent();
  const principal = { ...f.principal, tenantSlugs: [ORG_TENANT] as string[] };
  const request = f.run(() =>
    api.requestNhiSessionAdmission(principal, { nhi_id: agent.nhi_id, tenant_slug: ORG_TENANT })
  );
  approveAdmission(api.NHI_SESSION_ADMISSION_CHANNEL, request.request_id);
  const applied = f.run(() =>
    api.applyNhiSessionAdmission(principal, ORG_TENANT, request.request_id)
  );
  claimSession(agent.nhi_id, applied.session_id);
  f.run(() => safeWriteFile(`${f.root}/knowledge/personal/agent-identity.json`, '{invalid'));
  expect(f.run(() => inspect.inspectInstalledOnboardingRuntime(SCOPE))).toMatchObject({
    ready: false,
    reason: 'runtime_identity_unavailable',
  });
  claimSession();
});
