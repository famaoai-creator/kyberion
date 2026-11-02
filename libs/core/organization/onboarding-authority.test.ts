import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeRmSync } from '../secure-io.js';
import { humanActor } from '../actor.js';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
const f = useOnboardingAuthorityFixture();
const person = { kind: 'person' } as const;
describe('actual-store onboarding authority', () => {
  it('installs personal approval scope for trusted onboarding only and refuses public agent parents', async () => {
    const envelopes = await import('../scope-envelope.js');
    f.run(() => {
      const raw = f.input();
      const preview = f.api.previewOnboardingAuthority(f.principal, raw);
      const request = f.api.requestOnboardingAuthority(f.principal, raw, preview);
      expect(
        f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id).status
      ).toBe('pending');
      expect(
        f.approvals.loadApprovalRequest(f.api.ONBOARDING_AUTHORITY_CHANNEL, request.request_id)
      ).toBeNull();
      const parent = envelopes.mintScopeEnvelope({
        identity: { tier: 'public', session_id: 'public-agent-parent' },
        policy: { read_tiers: ['public'], write_tier: 'public', purpose: 'denial fixture' },
        env: { ...process.env, KYBERION_TIER: 'public' },
      });
      expect(() =>
        envelopes.withScopeEnvelope(parent, () =>
          f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
        )
      ).toThrow('personal approval scope conflicts');
      const foreign = envelopes.mintScopeEnvelope({
        identity: {
          tier: 'personal',
          nhi_id: 'kyberion://agent/foreign/owner',
          session_id: 'foreign-parent',
        },
        policy: {
          read_tiers: ['public', 'personal'],
          write_tier: 'personal',
          purpose: 'foreign denial fixture',
        },
        env: { ...process.env, KYBERION_TIER: 'personal' },
      });
      expect(() =>
        envelopes.withScopeEnvelope(foreign, () =>
          f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
        )
      ).toThrow('personal approval scope conflicts');
    });
  });

  it('presents changed and resulting delegated decision policies before owner consent', () =>
    f.run(() => {
      const raw = { ...f.input(), delegated_decisions: { meeting_scheduling: 'allow' as const } };
      const preview = f.api.previewOnboardingAuthority(f.principal, raw);
      expect(preview.statement).toContain(
        'Requested grant delegated decision meeting_scheduling: allow'
      );
      expect(preview.statement).toContain(
        'Resulting delegated decisions: {"meeting_scheduling":"allow"}'
      );
      const request = f.api.requestOnboardingAuthority(f.principal, raw, preview);
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      const revoke = {
        ...f.input(),
        grants: [],
        mode: 'revoke' as const,
        delegated_decisions: { meeting_scheduling: 'forbid' as const },
      };
      const next = f.api.previewOnboardingAuthority(f.principal, revoke);
      expect(next.statement).toContain(
        'Requested revoke delegated decision meeting_scheduling: forbid'
      );
      expect(next.statement).toContain('Resulting delegated decisions: {}');
    }));
  it('binds personal-tier delegation and initial identity activation to one exact owner consent', () =>
    f.run(() => {
      const identity = f.installAgent(false, 'combined-development');
      const raw = {
        ...f.input(),
        data_tier: { read: ['public', 'personal'], write: ['personal'] },
      };
      const preview = f.api.previewOnboardingAuthority(f.principal, raw);
      expect(preview.statement).toContain('personal');
      expect(preview.statement).toContain('also activates');
      expect(preview.statement).not.toContain('GitHub merge are not delegated');
      const request = f.api.requestOnboardingAuthority(f.principal, raw, preview);
      expect(() =>
        f.api.requestOnboardingAuthority(
          f.principal,
          { ...raw, data_tier: { read: ['public'], write: [] } },
          preview
        )
      ).toThrow();
      expect(f.identities.getAgentIdentity(identity.nhi_id)?.lifecycle_status).toBe('provisioned');
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      expect(f.identities.getAgentIdentity(identity.nhi_id)?.lifecycle_status).toBe('active');
      expect(f.charters.findActiveCharter(person, new Date())!.envelope.data_tier).toEqual({
        read: ['personal', 'public'],
        write: ['personal'],
      });
      expect(f.api.readOnboardingAuthority(f.principal, person).charter?.data_tier).toEqual({
        read: ['personal', 'public'],
        write: ['personal'],
      });
    }));
  it('preserves tier delegation on omission and only narrows it during revoke', () =>
    f.run(() => {
      const raw = {
        ...f.input(),
        data_tier: { read: ['public', 'personal'], write: ['personal'] },
      };
      const request = f.api.requestOnboardingAuthority(
        f.principal,
        raw,
        f.api.previewOnboardingAuthority(f.principal, raw)
      );
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      const amendment = {
        ...f.input(),
        grants: [{ operation_id: 'browser:goto' as const, origin: 'https://retained.test' }],
      };
      const next = f.api.requestOnboardingAuthority(
        f.principal,
        amendment,
        f.api.previewOnboardingAuthority(f.principal, amendment)
      );
      f.approve(next.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, next.request_id);
      expect(f.charters.findActiveCharter(person, new Date())!.envelope.data_tier.read).toContain(
        'personal'
      );
      const revoke = {
        ...f.input(),
        mode: 'revoke' as const,
        grants: [],
        data_tier: { read: ['public'], write: [] },
      };
      const narrowing = f.api.requestOnboardingAuthority(
        f.principal,
        revoke,
        f.api.previewOnboardingAuthority(f.principal, revoke)
      );
      f.approve(narrowing.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, narrowing.request_id);
      expect(f.charters.findActiveCharter(person, new Date())!.envelope.data_tier).toEqual({
        read: ['public'],
        write: [],
      });
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, {
          ...revoke,
          data_tier: { read: ['personal', 'public'], write: [] },
        })
      ).toThrow('cannot expand');
    }));
  it('permits only the actual scope tier and rejects activation-only tier widening', () =>
    f.run(() => {
      const preview = (
        scope_kind: 'person' | 'organization',
        data_tier: { read: string[]; write: string[] },
        tenant_slug?: string
      ) =>
        f.api.previewOnboardingAuthority(f.principal, {
          ...f.input(),
          scope_kind,
          ...(tenant_slug ? { tenant_slug } : {}),
          data_tier,
        });
      expect(() =>
        preview(
          'organization',
          { read: ['public', 'confidential:fixture-a'], write: ['confidential:fixture-a'] },
          'fixture-a'
        )
      ).not.toThrow();
      for (const tier of ['personal', 'confidential:fixture-b', 'confidential'])
        expect(() => preview('organization', { read: [tier], write: [] }, 'fixture-a')).toThrow(
          'actual scope'
        );
      expect(() => preview('person', { read: ['confidential:fixture-a'], write: [] })).toThrow(
        'actual scope'
      );
      f.installAgent(false, 'activation-tiers');
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, {
          ...f.input(),
          mode: 'activate',
          grants: [],
          data_tier: { read: ['public'], write: [] },
        })
      ).toThrow('must not include');
    }));
  it('activates a fresh installed identity after signed consent without standing outbound grants', () =>
    f.run(() => {
      const installed = f.installAgent(false, 'activation-only');
      const raw = { ...f.input(), mode: 'activate' as const, grants: [] };
      const preview = f.api.previewOnboardingAuthority(f.principal, raw);
      expect(preview.statement).toContain('No standing external operation is granted');
      const request = f.api.requestOnboardingAuthority(f.principal, raw, preview);
      expect(() =>
        f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
      ).toThrow();
      expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('provisioned');
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('active');
      const charter = f.charters.findActiveCharter(person, new Date())!;
      expect(charter.envelope.external_operations).toEqual([]);
      expect(charter.envelope.irreversible).toBe('forbid');
      expect(charter.envelope.money.per_action).toBe(0);
      expect(() => f.api.previewOnboardingAuthority(f.principal, raw)).toThrow('activation-only');
      const grantInput = f.input();
      const next = f.api.requestOnboardingAuthority(
        f.principal,
        grantInput,
        f.api.previewOnboardingAuthority(f.principal, grantInput)
      );
      expect(
        f.charters.findActiveCharter(person, new Date())?.envelope.external_operations
      ).toEqual([]);
      expect(() => f.api.applyOnboardingAuthority(f.principal, person, next.request_id)).toThrow();
      f.approve(next.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, next.request_id);
      expect(
        f.charters.findActiveCharter(person, new Date())?.envelope.external_operations
      ).toEqual(grantInput.grants);
    }));
  it('rejects activation-only consent mixed with grants, renewal, or an active identity', () =>
    f.run(() => {
      f.installAgent(false, 'activation-only-invalid');
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, { ...f.input(), mode: 'activate' })
      ).toThrow('must not include external grants');
      const raw = { ...f.input(), mode: 'activate', grants: [] };
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, { ...raw, renew_existing: true })
      ).toThrow('activation-only');
      f.installAgent(true, 'already-active');
      expect(() => f.api.previewOnboardingAuthority(f.principal, raw)).toThrow('activation-only');
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, { ...f.input(), grants: [] })
      ).toThrow('choose at least one');
    }));
  it('cannot use activation-only consent to replace an existing charter', () =>
    f.run(() => {
      const first = f.request();
      f.approve(first.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, first.request_id);
      const original = f.charters.findActiveCharter(person, new Date());
      f.installAgent(false, 'replacement-provisioned');
      expect(() =>
        f.api.previewOnboardingAuthority(f.principal, {
          ...f.input(),
          mode: 'activate',
          grants: [],
        })
      ).toThrow('without an existing charter');
      expect(f.charters.findActiveCharter(person, new Date())).toEqual(original);
    }));
  it('requires fresh explicit renewal after an approved live amendment is overtaken by retirement', () =>
    f.run(() => {
      const first = f.request();
      f.approve(first.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, first.request_id);
      const current = f.charters.findActiveCharter(person, new Date())!;
      const next = {
        ...f.input(),
        grants: [{ operation_id: 'browser:goto' as const, origin: 'https://renewal.test' }],
      };
      const amendment = f.api.requestOnboardingAuthority(
        f.principal,
        next,
        f.api.previewOnboardingAuthority(f.principal, next)
      );
      f.approve(amendment.request_id);
      f.charters.retireCharter(current, humanActor('owner'), 'Synthetic retirement after approval');
      expect(() =>
        f.api.applyOnboardingAuthority(f.principal, person, amendment.request_id)
      ).toThrow();
      expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
      expect(() => f.api.previewOnboardingAuthority(f.principal, next)).toThrow('renew_existing');
      const renewed = { ...next, renew_existing: true };
      const preview = f.api.previewOnboardingAuthority(f.principal, renewed);
      expect(preview.statement).toContain(current.charter_id);
      const request = f.api.requestOnboardingAuthority(f.principal, renewed, preview);
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      const active = f.charters.findActiveCharter(person, new Date())!;
      expect(active.envelope.money).toEqual(current.envelope.money);
      expect(active.appetite).toEqual(current.appetite);
      expect(active.envelope.external_operations).toEqual(
        expect.arrayContaining([...f.input().grants, ...next.grants])
      );
    }));
  it('does not mint an anonymous NHI when the installed primary profile is missing', () =>
    f.run(() => {
      const before = f.identities.listAgentIdentities();
      safeRmSync(path.join(f.root, 'knowledge/personal/agent-identity.json'));
      expect(() => f.api.previewOnboardingAuthority(f.principal, f.input())).toThrow();
      expect(f.identities.listAgentIdentities()).toEqual(before);
      expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
    }));
  it('rejects approval after the installed primary NHI is replaced', () =>
    f.run(() => {
      const request = f.request();
      f.approve(request.request_id);
      f.installAgent(true, 'replacement-install');
      expect(() =>
        f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
      ).toThrow();
      expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
    }));
  it.each(['suspended', 'retired'] as const)(
    'never activates an installed NHI that became %s after human approval',
    (status) =>
      f.run(() => {
        const installed = f.installAgent(false, 'revoked-install');
        const request = f.request();
        f.approve(request.request_id);
        f.governIdentity(() =>
          status === 'suspended'
            ? f.identities.suspendAgentIdentity(installed.nhi_id, 'Synthetic hold')
            : f.identities.retireAgentIdentity(installed.nhi_id, 'Synthetic retirement')
        );
        expect(() =>
          f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
        ).toThrow();
        expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe(status);
        expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
      })
  );
  it('keeps a provisioned installed NHI inactive until its exact activation plan is human-approved', () =>
    f.run(() => {
      const installed = f.installAgent(false, 'pending-install');
      const raw = f.input();
      const preview = f.api.previewOnboardingAuthority(f.principal, raw);
      expect(preview.statement).toContain(installed.nhi_id);
      const request = f.api.requestOnboardingAuthority(f.principal, raw, preview);
      expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('provisioned');
      expect(() =>
        f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
      ).toThrow();
      expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('provisioned');
      f.approve(request.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      expect(f.identities.getAgentIdentity(installed.nhi_id)?.lifecycle_status).toBe('active');
    }));
  it('requires an exact reviewed digest and confers no authority while pending', () =>
    f.run(() => {
      const raw = f.input();
      const reviewed = f.api.previewOnboardingAuthority(f.principal, raw);
      expect(() =>
        f.api.requestOnboardingAuthority(
          f.principal,
          {
            ...raw,
            grants: [
              { operation_id: 'vcs:pr_create', repository: 'https://github.com/fixture/other' },
            ],
          },
          reviewed
        )
      ).toThrow('review changed');
      const request = f.api.requestOnboardingAuthority(f.principal, raw, reviewed);
      expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
      expect(
        f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
      ).toMatchObject({ status: 'pending', can_apply: false });
      expect(() => f.api.applyOnboardingAuthority(f.principal, person, request.request_id)).toThrow(
        'approval'
      );
      expect(f.api.requestOnboardingAuthority(f.principal, raw, reviewed).request_id).toBe(
        request.request_id
      );
    }));
  it('rejects agent self-decision and applies an actual signed human decision once', () =>
    f.personal(() => {
      const request = f.request();
      const record = f.approvals.loadApprovalRequest(
        f.api.ONBOARDING_AUTHORITY_CHANNEL,
        request.request_id
      )!;
      expect(() =>
        f.approvals.decideApprovalRequest('mission_controller', {
          channel: record.channel,
          requestId: record.id,
          decision: 'approved',
          decidedBy: 'user:owner',
          decidedByType: 'human',
          authenticated: true,
          authMethod: 'surface_session',
          presentedDigest: f.approvals.computeApprovalPresentedDigest(record),
          payloadHash: record.accountability?.payloadHash,
          effectBinding: record.accountability?.effectBinding,
          deciderPrincipal: {
            actor: { kind: 'agent', id: 'kyberion://agent/setup/requester' },
            provider: 'agent-context',
            source: 'agent',
            principalId: 'agent',
          },
        })
      ).toThrow('APPROVAL_HUMAN_PROOF_REQUIRED');
      f.approve(request.request_id);
      expect(
        f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
      ).toMatchObject({ can_apply: true });
      const applied = f.api.applyOnboardingAuthority(f.principal, person, request.request_id);
      expect(f.charters.findActiveCharter(person, new Date())?.charter_id).toBe(applied.charter_id);
      expect(() =>
        f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
      ).toThrow();
      expect(
        f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
      ).toMatchObject({ status: 'applied', can_apply: false });
    }));
  it('discovers retained CLI requests only within the authorized owner and scope', () =>
    f.run(() => {
      const request = f.request();
      expect(
        f.api.readOnboardingAuthority(f.principal, person).pending_requests.map((r) => r.request_id)
      ).toContain(request.request_id);
      expect(
        f.api.readOnboardingAuthority(f.principal, {
          kind: 'organization',
          tenant_slug: 'fixture-a',
        }).pending_requests
      ).toEqual([]);
      expect(() =>
        f.api.onboardingAuthorityRequestStatus(
          f.principal,
          { kind: 'organization', tenant_slug: 'fixture-b' },
          request.request_id
        )
      ).toThrow('request not found');
      expect(() =>
        f.api.readOnboardingAuthority({ ...f.principal, personalOwner: false }, person)
      ).toThrow('owner');
      expect(() =>
        f.api.readOnboardingAuthority(
          { ...f.principal, tenantSlugs: [] },
          { kind: 'organization', tenant_slug: 'fixture-a' }
        )
      ).toThrow('owner');
      const owner = f.members.readMemberProfile('owner')!;
      f.members.writeMemberProfile({
        ...owner,
        member_id: 'other-owner',
        display_name: 'Other registered owner',
        external_identities: [],
      });
      expect(() =>
        f.api.onboardingAuthorityRequestStatus(
          { ...f.principal, accountableId: 'user:other-owner' },
          person,
          request.request_id
        )
      ).toThrow('owner');
    }));
  it('rejects a stale approved amendment and revokes only the selected actual grant', () =>
    f.run(() => {
      const first = f.request();
      f.approve(first.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, first.request_id);
      const browser = {
        ...f.input(),
        grants: [{ operation_id: 'browser:goto' as const, origin: 'https://example.test' }],
      };
      const stale = f.api.previewOnboardingAuthority(f.principal, browser);
      const second = f.api.requestOnboardingAuthority(f.principal, browser, stale);
      f.approve(second.request_id);
      const alternate = {
        ...f.input(),
        grants: [{ operation_id: 'browser:open_tab' as const, origin: 'https://other.test' }],
      };
      const concurrent = f.api.requestOnboardingAuthority(
        f.principal,
        alternate,
        f.api.previewOnboardingAuthority(f.principal, alternate)
      );
      f.approve(concurrent.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, concurrent.request_id);
      expect(() => f.api.applyOnboardingAuthority(f.principal, person, second.request_id)).toThrow(
        'changed after review'
      );
      const revoke = { ...f.input(), mode: 'revoke' as const };
      const req = f.api.requestOnboardingAuthority(
        f.principal,
        revoke,
        f.api.previewOnboardingAuthority(f.principal, revoke)
      );
      f.approve(req.request_id);
      f.api.applyOnboardingAuthority(f.principal, person, req.request_id);
      expect(
        f.charters.findActiveCharter(person, new Date())?.envelope.external_operations
      ).toEqual(alternate.grants);
    }));
  it('refuses expired approvals without creating a charter', () =>
    f.run(() => {
      const raw = { ...f.input(), expires_at: new Date(Date.now() + 60_000).toISOString() };
      const request = f.api.requestOnboardingAuthority(
        f.principal,
        raw,
        f.api.previewOnboardingAuthority(f.principal, raw)
      );
      f.approve(request.request_id);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 120_000 });
      try {
        expect(
          f.api.onboardingAuthorityRequestStatus(f.principal, person, request.request_id)
        ).toMatchObject({ status: 'expired', can_apply: false });
        expect(() =>
          f.api.applyOnboardingAuthority(f.principal, person, request.request_id)
        ).toThrow();
        expect(f.charters.findActiveCharter(person, new Date())).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    }));
});
