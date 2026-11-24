/**
 * Actual stores: a personal-scope onboarding-authority request is invisible
 * to a plain terminal listing and becomes listable and decidable through the
 * installed owner's personal approval scope (no KYBERION_TIER/NHI env).
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../tests/helpers/onboarding-authority-fixture.js';

const f = useOnboardingAuthorityFixture();

async function loadCliScope() {
  // After the fixture's module reset, so both sides share one store instance.
  const scope = await import('./cli-personal-approvals.js');
  const identity = await import('@agent/core/personal-identity-state');
  const profile = await import('@agent/core/profile-root');
  f.run(() =>
    identity.writePersonalIdentityAtPath(
      path.join(profile.resolveActiveProfileRoot(), 'my-identity.json'),
      {
        name: 'Synthetic owner',
        language: 'en',
        interaction_style: 'Minimalist',
        primary_domain: 'fixture',
        persona: 'sovereign',
        status: 'active',
        version: '1.0.0',
        created_at: new Date().toISOString(),
      }
    )
  );
  return scope;
}

describe('terminal access to the owner personal approvals', () => {
  it('lists and decides a personal request only through the personal scope', async () => {
    const scope = await loadCliScope();
    const receipt = f.request();
    const list = () => f.approvals.listApprovalRequests({ status: 'pending' });

    // The defect: a plain terminal listing never sees the personal partition.
    expect(f.run(list).some((record) => record.id === receipt.request_id)).toBe(false);

    const pending = scope.listCliPendingApprovals(list);
    const record = pending.find((entry) => entry.id === receipt.request_id);
    expect(record).toBeDefined();
    expect(scope.isPersonalPartitionApproval(record!)).toBe(true);

    // What the terminal challenge produces (A2), written through the personal scope.
    const storeScope = scope.cliApprovalStoreScope(record!);
    expect(storeScope).toBeDefined();
    const decided = storeScope!(() =>
      f.approvals.decideApprovalRequest('mission_controller', {
        channel: record!.channel,
        storageChannel: record!.storageChannel,
        requestId: record!.id,
        decision: 'approved',
        decidedBy: 'user:owner',
        decidedByRole: 'sovereign',
        decidedVia: 'cli_tty_challenge',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'terminal_attested',
        presentedDigest: f.approvals.computeApprovalPresentedDigest(record!),
      })
    );
    expect(decided.status).toBe('approved');
    // The onboarding-authority consumer accepts the terminal decision end to end.
    const person = { kind: 'person' } as const;
    expect(
      f.run(() => f.api.onboardingAuthorityRequestStatus(f.principal, person, receipt.request_id))
        .can_apply
    ).toBe(true);
    f.run(() => f.api.applyOnboardingAuthority(f.principal, person, receipt.request_id));
    expect(
      f.run(() => f.api.onboardingAuthorityRequestStatus(f.principal, person, receipt.request_id))
        .status
    ).toBe('applied');
  });
});
