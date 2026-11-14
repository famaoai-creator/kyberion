import { describe, expect, it, afterEach } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
const f = useOnboardingAuthorityFixture();
async function modules() {
  const [api, bindings, encryption, guard, envelopes] = await Promise.all([
    import('./account-introduction.js'),
    import('../service/service-binding-registry.js'),
    import('./secret-encryption.js'),
    import('./secret-guard.js'),
    import('../scope-envelope.js'),
  ]);
  return { api, bindings, encryption, guard, envelopes };
}
afterEach(async () =>
  (await import('./secret-encryption.js')).overrideSecretEncryptionKeyForTests(null)
);
describe('actual-store account introduction', () => {
  it('keeps approval personal, requires the authenticated owner, then writes only encrypted exact material', async () => {
    const { api, bindings, encryption, guard, envelopes } = await modules();
    encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 17));
    await f.run(async () => {
      bindings.saveServiceBindingRecord({
        binding_id: 'personal-slack',
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
      const preview = api.previewAccountIntroduction(f.principal, 'personal-slack');
      const requested = api.proposeAccountIntroduction(f.principal, 'personal-slack', preview);
      expect(
        f.approvals.loadApprovalRequest(api.ACCOUNT_INTRODUCTION_CHANNEL, requested.approval_id)
      ).toBeNull();
      expect(
        api.accountIntroductionStatus(f.principal, 'personal-slack', requested.approval_id).status
      ).toBe('pending');
      const publicParent = envelopes.mintScopeEnvelope({
        identity: { tier: 'public', session_id: 'account-test' },
        policy: { read_tiers: ['public'], write_tier: 'public', purpose: 'account scope denial' },
        env: { ...process.env, KYBERION_TIER: 'public' },
      });
      expect(() =>
        envelopes.withScopeEnvelope(publicParent, () =>
          api.accountIntroductionStatus(f.principal, 'personal-slack', requested.approval_id)
        )
      ).toThrow();
      f.personal(() => {
        const record = f.approvals.loadApprovalRequest(
          api.ACCOUNT_INTRODUCTION_CHANNEL,
          requested.approval_id
        )!;
        f.approvals.decideApprovalRequest('mission_controller', {
          channel: record.channel,
          requestId: record.id,
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
      expect(
        api.accountIntroductionStatus(f.principal, 'personal-slack', requested.approval_id)
          .can_apply
      ).toBe(true);
      const result = await api.applyAccountIntroduction(f.principal, 'personal-slack', {
        approval_id: requested.approval_id,
        material: { SLACK_TOKEN: 'synthetic-account-token' },
      });
      expect(result.status).toBe('applied');
      expect(
        guard.loadLocalAccountMaterial({
          serviceId: 'slack',
          bindingId: 'personal-slack',
          ownerKind: 'person',
          ownerRef: 'user:owner',
          generation: result.generation,
        })
      ).toEqual({ SLACK_TOKEN: 'synthetic-account-token' });
      expect(guard.loadConnectionDocument('slack')).toEqual({});
      expect(
        api.accountIntroductionStatus(f.principal, 'personal-slack', requested.approval_id).status
      ).toBe('applied');
    });
  });
  it('registers an organization account from the installed operator without a tenant execution identity', async () => {
    const { api, bindings, encryption, guard } = await modules();
    const resolver = await import('./secret-resolver.js');
    encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 17));
    const dispose = resolver.registerSecretResolver(
      {
        name: 'synthetic-broker',
        resolve: () => null,
        accountProvisioner: {
          id: 'synthetic-destination',
          provision: (request) => ({
            version: 1,
            requestId: request.requestId,
            reference: request.reference,
            expectedGeneration: request.expectedGeneration,
            status: 'provisioned',
          }),
        },
      },
      { provenance: 'generated', source: 'account-integration-fixture' }
    );
    try {
      await f.run(async () => {
        bindings.saveServiceBindingRecord({
          binding_id: 'org-slack',
          service_id: 'slack',
          service_type: 'slack',
          scope: 'workspace',
          target: 'synthetic',
          owner_kind: 'organization',
          owner_ref: 'fixture-a',
          tenant_slug: 'fixture-a',
          auth_mode: 'secret-guard',
          secret_refs: ['SLACK_TOKEN'],
          allowed_actions: ['auth_test'],
          approval_policy: { auth_test: 'allowed' },
        });
        const preview = api.previewAccountIntroduction(f.principal, 'org-slack');
        const requested = api.proposeAccountIntroduction(f.principal, 'org-slack', preview);
        const record = f.approvals.loadApprovalRequest(
          api.ACCOUNT_INTRODUCTION_CHANNEL,
          requested.approval_id
        )!;
        expect(record.scope).toMatchObject({ tier: 'confidential', tenant_slug: 'fixture-a' });
        expect(record.requestedBy).toBe(f.installedId);
        expect(() =>
          api.accountIntroductionStatus(
            { ...f.principal, tenantSlugs: ['fixture-b'] },
            'org-slack',
            requested.approval_id
          )
        ).toThrow();
        f.approvals.decideApprovalRequest('mission_controller', {
          channel: record.channel,
          requestId: record.id,
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
        const result = await api.applyAccountIntroduction(f.principal, 'org-slack', {
          approval_id: requested.approval_id,
          material: { SLACK_TOKEN: 'synthetic-organization-token' },
        });
        expect(result.status).toBe('applied');
        expect(
          guard.loadLocalAccountRegistration({
            serviceId: 'slack',
            bindingId: 'org-slack',
            ownerKind: 'organization',
            ownerRef: 'fixture-a',
            tenantSlug: 'fixture-a',
          })
        ).toEqual({ generation: result.generation });
        expect(guard.loadConnectionDocument('slack')).toEqual({});
      });
    } finally {
      dispose();
    }
  });
});
