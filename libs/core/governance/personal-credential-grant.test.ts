import { afterEach, describe, expect, it } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
import type { PersonalCredentialGrantSelection } from './personal-credential-grant.js';
const f = useOnboardingAuthorityFixture();
const generation = '12345678-1234-4123-8123-123456789abc';
const address = {
  bindingId: 'personal-slack',
  serviceId: 'slack',
  ownerKind: 'person' as const,
  ownerRef: 'user:owner',
};
const selection: PersonalCredentialGrantSelection = {
  bindingId: address.bindingId,
  projectId: 'project-a',
  missionId: 'MSN-A',
  taskId: 'task-a',
  allowedActions: ['auth_test'],
  purpose: 'Synthetic personal read consent',
  ttlDays: 1,
};
async function setup() {
  const api = await import('./personal-credential-grant.js');
  const store = {
    ...(await import('./grant-store.js')),
    ...(await import('./personal-credential-grant-store.js')),
  };
  const bindings = await import('../service/service-binding-registry.js');
  const guard = await import('../secret/secret-guard.js');
  const encryption = await import('../secret/secret-encryption.js');
  encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 17));
  f.run(() => {
    bindings.saveServiceBindingRecord({
      binding_id: address.bindingId,
      service_id: 'slack',
      service_type: 'slack',
      scope: 'personal',
      target: 'synthetic',
      owner_kind: 'person',
      owner_ref: 'user:owner',
      auth_mode: 'secret-guard',
      secret_refs: ['SLACK_TOKEN'],
      allowed_actions: ['auth_test'],
      approval_policy: { auth_test: 'allowed' },
    });
    // Only encrypted registration metadata exists. No token is created or consumed.
    guard.storeLocalAccountRegistration(address, { generation });
  });
  return { api, store, guard, bindings };
}
function approve(id: string) {
  return f.personal(() => {
    const record = f.approvals.loadApprovalRequest('grant-standing', id)!;
    return f.approvals.decideApprovalRequest('mission_controller', {
      channel: record.channel,
      requestId: id,
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
afterEach(async () =>
  (await import('../secret/secret-encryption.js')).overrideSecretEncryptionKeyForTests(null)
);

describe('personal standing credential consent prerequisite', () => {
  it('refuses owner or unrelated-agent requests instead of attributing them to the installed NHI', async () => {
    const { api } = await setup();
    for (const requesterId of ['user:owner', 'user:other', 'kyberion://agent/_/_/other', '']) {
      expect(() =>
        f.run(() =>
          api.requestPersonalCredentialGrantApproval({ ...f.principal, requesterId }, selection)
        )
      ).toThrow('[PERSONAL_CREDENTIAL_GRANT_DENIED]');
    }
    expect(f.personal(() => f.approvals.listApprovalRequests({ status: 'pending' }))).toEqual([]);
    const requested = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    expect(requested.requestedBy).toBe(f.installedId);
    expect(requested.requestedByContext?.actorId).toBe(f.installedId);
    approve(requested.id);
    const granted = f.run(() =>
      api.grantPersonalCredentialUse(f.principal, selection, requested.id)
    );
    expect(granted.granted_by.actor_id).toBe('user:owner');
  });

  it('keeps legacy management-only consent readable and revocable without runtime opt-in', async () => {
    const { api, store } = await setup();
    const requested = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    approve(requested.id);
    const current = f.run(() =>
      api.grantPersonalCredentialUse(f.principal, selection, requested.id)
    );
    expect(current.scope.runtime_use).toBe('selected-read-api-v1');
    const { runtime_use: _runtime, ...legacyScope } = current.scope;
    const { personalCredentialGrantPayload, personalCredentialGrantEffect } =
      await import('./personal-credential-grant-scope.js');
    const { computeApprovalPayloadHash } = await import('./approval-presentation.js');
    const { markApprovalConsumed } = await import('./approval-revocation.js');
    const draft = { scope: legacyScope, purpose: current.purpose, ttl_days: 1 };
    const oldApproval = f.personal(() =>
      f.approvals.createApprovalRequest('mission_controller', {
        channel: 'grant-standing',
        requestedBy: f.installedId,
        requestedByContext: {
          surface: 'system',
          actorId: f.installedId,
          actorRole: 'grant-standing',
        },
        scope: { tier: 'personal', scope_kind: 'system', nhi_id: f.installedId },
        draft: { title: 'Legacy consent fixture', summary: 'Runtime token use remains disabled.' },
        workflow: {
          workflowId: 'legacy-consent',
          mode: 'all_required',
          requiredRoles: ['owner'],
          stages: [],
          approvals: [{ role: 'owner', status: 'pending' }],
        },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: computeApprovalPayloadHash(personalCredentialGrantPayload(draft)),
          effectBinding: personalCredentialGrantEffect(draft),
        },
      })
    );
    approve(oldApproval.id);
    const grantId = 'GRT-20261114-abcdef123456';
    const consumed = f.personal(() =>
      markApprovalConsumed('mission_controller', {
        channel: 'grant-standing',
        requestId: oldApproval.id,
        consumer: 'grant_standing',
        consumedBy: 'user:owner',
        effectRef: grantId,
      })
    );
    const at = consumed.consumption!.consumedAt;
    const legacy = {
      ...current,
      grant_id: grantId,
      scope: legacyScope,
      basis: { approval_request_id: oldApproval.id, approval_channel: 'grant-standing' },
      granted_at: at,
      expires_at: new Date(Date.parse(at) + 86400_000).toISOString(),
    };
    f.personal(() => store.writePersonalCredentialGrantRecord(legacy));
    expect(
      f.personal(() => store.loadPersonalCredentialGrantRecord('user:owner', grantId))
    ).toEqual(legacy);
    expect(f.personal(() => api.verifyPersonalCredentialGrantBasis(legacy))).toBe(true);
    expect(
      f.run(() =>
        api.revokePersonalCredentialGrant(f.principal, grantId, 'withdraw legacy consent')
      ).revoked
    ).toBeTruthy();
  });
  it('uses actual personal grant and approval stores while remaining excluded from tenant APIs', async () => {
    const { api, store } = await setup();
    const approval = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    expect(f.run(() => f.approvals.loadApprovalRequest('grant-standing', approval.id))).toBeNull();
    expect(() =>
      f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id))
    ).toThrow();
    approve(approval.id);
    const grant = f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id));
    expect(grant.custody).toEqual({ kind: 'person', ref: 'owner' });
    expect(grant.scope).toMatchObject({
      owner_ref: 'user:owner',
      nhi_id: f.installedId,
      project_id: 'project-a',
      mission_id: 'MSN-A',
      task_id: 'task-a',
      generation,
    });
    expect(store.validateGrantRecord(grant).valid).toBe(false);
    expect(store.verifyGrantBasis(grant as unknown as import('./grant-store.js').GrantRecord)).toBe(
      false
    );
    expect(store.validatePersonalCredentialGrantRecord(grant).valid).toBe(true);
    expect(
      f.personal(() => store.loadPersonalCredentialGrantRecord('user:owner', grant.grant_id))
    ).toEqual(grant);
    expect(
      f.personal(() => ({
        value: store.loadPersonalCredentialGrantRecord('user:other', grant.grant_id),
      })).value
    ).toBeNull();
    expect(
      f.personal(() => ({ value: store.loadGrant(undefined, grant.grant_id) })).value
    ).toBeNull();
    expect(f.personal(() => api.verifyPersonalCredentialGrantBasis(grant))).toBe(true);
    expect(() =>
      f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id))
    ).toThrow();
    const revoked = f.run(() =>
      api.revokePersonalCredentialGrant(f.principal, grant.grant_id, 'withdraw consent')
    );
    expect(revoked.revoked?.by).toBe('user:owner');
    // Removing the record's revocation cannot resurrect independently withdrawn approval.
    expect(f.personal(() => api.verifyPersonalCredentialGrantBasis(grant))).toBe(false);
  });
  it('refuses generation drift, changed task and unselected actions before grant creation', async () => {
    const { api, guard } = await setup();
    const approval = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    approve(approval.id);
    expect(() =>
      f.run(() =>
        api.grantPersonalCredentialUse(f.principal, { ...selection, taskId: 'task-b' }, approval.id)
      )
    ).toThrow();
    expect(() =>
      f.run(() =>
        api.grantPersonalCredentialUse(
          f.principal,
          { ...selection, projectId: 'project-b' },
          approval.id
        )
      )
    ).toThrow();
    expect(() =>
      f.run(() =>
        api.requestPersonalCredentialGrantApproval(
          { ...f.principal, requesterId: f.installedId },
          {
            ...selection,
            allowedActions: ['write'],
          }
        )
      )
    ).toThrow();
    f.run(() =>
      guard.storeLocalAccountRegistration(address, {
        generation: 'aaaaaaaa-1234-4123-8123-123456789abc',
      })
    );
    expect(() =>
      f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id))
    ).toThrow();
  });
  it('rejects unauthenticated owner claims, inactive installed NHI and pending registration', async () => {
    const { api, guard } = await setup();
    expect(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    ).toThrow();
    expect(() =>
      f.run(() =>
        api.requestPersonalCredentialGrantApproval(
          { ...f.principal, requesterId: f.installedId, accountableId: 'user:other' },
          selection
        )
      )
    ).toThrow();
    f.run(() =>
      guard.storeLocalAccountRegistration(address, { generation, pendingApprovalId: 'pending' })
    );
    expect(() =>
      f.run(() =>
        api.requestPersonalCredentialGrantApproval(
          { ...f.principal, requesterId: f.installedId },
          selection
        )
      )
    ).toThrow();
    f.installAgent(false, 'inactive-test');
    expect(() =>
      f.run(() =>
        api.requestPersonalCredentialGrantApproval(
          { ...f.principal, requesterId: f.installedId },
          selection
        )
      )
    ).toThrow();
  });
  it('rejects mixed/forged personal records and legacy tenant issuance of personal capability', async () => {
    const { api, store } = await setup();
    const approval = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    approve(approval.id);
    const grant = f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id));
    for (const scope of [
      { ...grant.scope, tenant_slug: 'acme' },
      { ...grant.scope, nhi_id: 'kyberion://agent/acme/_/worker' },
      { ...grant.scope, project_id: '' },
      { ...grant.scope, owner_ref: 'user:other' },
    ])
      expect(store.validatePersonalCredentialGrantRecord({ ...grant, scope }).valid).toBe(false);
    expect(() =>
      store.normalizeGrantDraft({
        capability: 'credential.personal_use',
        tenant_slug: 'acme',
        purpose: 'forged',
      })
    ).toThrow();
    expect(
      f.personal(() =>
        api.verifyPersonalCredentialGrantBasis({
          ...grant,
          scope: { ...grant.scope, task_id: 'task-b' },
        })
      )
    ).toBe(false);
    expect(
      f.personal(() =>
        api.verifyPersonalCredentialGrantBasis({ ...grant, grant_id: 'GRT-20261114-aaaaaaaaaaaa' })
      )
    ).toBe(false);
  });
  it.each(['rotated', 'suspended'] as const)(
    'allows the human owner to withdraw after NHI is %s',
    async (change) => {
      const { api } = await setup();
      const approval = f.run(() =>
        api.requestPersonalCredentialGrantApproval(
          { ...f.principal, requesterId: f.installedId },
          selection
        )
      );
      approve(approval.id);
      const grant = f.run(() =>
        api.grantPersonalCredentialUse(f.principal, selection, approval.id)
      );
      if (change === 'rotated') f.installAgent(false, 'replacement-agent');
      else
        f.governIdentity(() =>
          f.identities.suspendAgentIdentity(f.installedId, 'synthetic suspension')
        );
      const revoked = f.run(() =>
        api.revokePersonalCredentialGrant(f.principal, grant.grant_id, 'human withdrawal')
      );
      expect(revoked.revoked?.by).toBe('user:owner');
      // The historical approval was withdrawn, not only the copied grant record.
      const envelopes = await import('../scope-envelope.js');
      const envelope = envelopes.mintScopeEnvelope({
        identity: {
          tier: 'personal',
          nhi_id: grant.scope.nhi_id,
          session_id: 'synthetic-historical-check',
        },
        policy: {
          purpose: 'test historical revocation',
          read_tiers: ['personal', 'public'],
          write_tier: 'personal',
        },
        env: { ...process.env, KYBERION_TIER: 'personal' },
      });
      expect(
        f.run(() =>
          envelopes.withScopeEnvelope(
            envelope,
            () => f.approvals.loadApprovalRequest('grant-standing', approval.id)?.revocation
          )
        )
      ).toBeTruthy();
    }
  );
  it('refuses a forged historical NHI belonging to another owner', async () => {
    const { api, store } = await setup();
    const approval = f.run(() =>
      api.requestPersonalCredentialGrantApproval(
        { ...f.principal, requesterId: f.installedId },
        selection
      )
    );
    approve(approval.id);
    const grant = f.run(() => api.grantPersonalCredentialUse(f.principal, selection, approval.id));
    const foreign = f.governIdentity(() =>
      f.identities.issueAgentIdentity({
        kind: 'agent',
        slug: 'foreign-person',
        personScope: true,
        displayName: 'Synthetic foreign agent',
        accountableHumanId: 'user:other',
      })
    );
    f.personal(() =>
      store.writePersonalCredentialGrantRecord({
        ...grant,
        scope: { ...grant.scope, nhi_id: foreign.nhi_id },
      })
    );
    expect(() =>
      f.run(() => api.revokePersonalCredentialGrant(f.principal, grant.grant_id, 'forged'))
    ).toThrow();
    expect(
      f.personal(() => f.approvals.loadApprovalRequest('grant-standing', approval.id)?.revocation)
    ).toBeUndefined();
  });
});
