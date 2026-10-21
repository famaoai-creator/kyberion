import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeRmSync } from '../secure-io.js';
import { humanActor } from '../actor.js';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';
const f = useOnboardingAuthorityFixture();
const person = { kind: 'person' } as const;
describe('actual-store onboarding authority', () => {
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
    f.run(() => {
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
      ).toThrow('outside');
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
