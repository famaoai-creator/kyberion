/** Synthetic identity, actual stores and signed browser authentication. Never reads user state. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { safeRmSync } from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from '../../scripts/fixtures/first-job-approval-fixture.js';

export function useOnboardingAuthorityFixture() {
  const sourceRoot = process.cwd();
  const root = path.join(
    sourceRoot,
    'active/shared/tmp',
    'onboarding-authority-test-' + randomUUID()
  );
  let api: typeof import('@agent/core/organization/onboarding-authority');
  let authority: typeof import('@agent/core/authority');
  let members: typeof import('@agent/core/organization/member-registry');
  let approvals: typeof import('@agent/core/governance/approval-store');
  let charters: typeof import('@agent/core/governance/accountability-charter-registry');
  let surfaceAuthn: typeof import('@agent/core/surface/surface-authn');
  let browser: typeof import('@agent/core/authn-providers');
  let identities: typeof import('@agent/core/agent/agent-identity');
  let personalIdentity: typeof import('@agent/core/personal-identity-state');
  let installedId = '';
  let verified: ReturnType<typeof surfaceAuthn.resolveAuthnSurfaceViewerScope>;
  const principal = {
    requesterId: 'kyberion://agent/setup/requester',
    accountableId: 'user:owner',
    personalOwner: true,
    tenantSlugs: ['fixture-a', 'fixture-b'],
  };
  const input = () => ({
    scope_kind: 'person' as const,
    mode: 'grant' as const,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    grants: [
      { operation_id: 'vcs:pr_create' as const, repository: 'https://github.com/fixture/repo' },
    ],
  });
  const run = <T>(body: () => T): T => authority.withExecutionContext('sovereign_concierge', body);
  beforeAll(async () => {
    seedFirstJobTestRoot(sourceRoot, root);
    process.chdir(root);
    vi.stubEnv('KYBERION_ROOT', root);
    vi.stubEnv('SYSTEM_ROLE', 'concierge');
    vi.stubEnv('MISSION_ROLE', 'worker');
    vi.stubEnv('KYBERION_PERSONA', 'worker');
    for (const key of [
      'MISSION_ID',
      'KYBERION_TENANT',
      'KYBERION_ORGANIZATION',
      'KYBERION_PROJECT_ID',
      'KYBERION_SUDO',
      'KYBERION_CUSTOMER',
    ])
      vi.stubEnv(key, '');
    vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
    vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
    vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
    vi.resetModules();
    authority = await import('@agent/core/authority');
    members = await import('@agent/core/organization/member-registry');
    approvals = await import('@agent/core/governance/approval-store');
    charters = await import('@agent/core/governance/accountability-charter-registry');
    api = await import('@agent/core/organization/onboarding-authority');
    browser = await import('@agent/core/authn-providers');
    surfaceAuthn = await import('@agent/core/surface/surface-authn');
    identities = await import('@agent/core/agent/agent-identity');
    personalIdentity = await import('@agent/core/personal-identity-state');
  }, 60000);
  beforeEach(() => {
    run(() => {
      for (const relative of ['knowledge/personal', 'knowledge/confidential', 'active'])
        safeRmSync(path.join(root, relative), { recursive: true, force: true });
      members.writeMemberProfile({
        ...syntheticFirstJobOwner('fixture-a'),
        memberships: [
          { tenant_slug: 'fixture-a', role: 'owner' },
          { tenant_slug: 'fixture-b', role: 'owner' },
        ],
      });
      identities.resetAgentIdentityServiceForTests(
        path.join(root, 'active/shared/tmp', 'agent-identities.jsonl')
      );
      installAgent();
    });
    const token = browser.mintBrowserSessionToken({
      idpIssuer: FIRST_JOB_TEST_ISSUER,
      subject: FIRST_JOB_TEST_SUBJECT,
      ttlSeconds: 1800,
    }).token;
    verified = run(() =>
      surfaceAuthn.resolveAuthnSurfaceViewerScope({
        token,
        local: false,
        allowLoopback: false,
        registrations: null,
        configuredCredentials: [],
        providerIds: ['browser-session'],
        surface: 'onboarding-authority-test',
      })
    );
  });
  afterAll(() => {
    process.chdir(sourceRoot);
    vi.unstubAllEnvs();
    safeRmSync(root, { recursive: true, force: true });
  });
  const request = (raw = input()) =>
    run(() => {
      const reviewed = api.previewOnboardingAuthority(principal, raw);
      return api.requestOnboardingAuthority(principal, raw, reviewed);
    });
  function installAgent(active = true, slug = 'onboarding-test') {
    const record = authority.withExecutionContext('mission_controller', () => {
      const issued = identities.issueAgentIdentity({
        kind: 'agent',
        slug,
        organizationId: 'fixture-system',
        displayName: 'Synthetic installed agent',
        accountableHumanId: 'user:owner',
      });
      return active ? identities.activateAgentIdentity(issued.nhi_id) : issued;
    });
    run(() =>
      personalIdentity.writePersonalAgentIdentityAtPath(
        path.join(root, 'knowledge/personal/agent-identity.json'),
        {
          agent_id: slug,
          nhi_id: record.nhi_id,
          version: '1.0.0',
          role: 'Synthetic test assistant',
          owner: members.readMemberProfile('owner')!.display_name,
          trust_tier: 'sovereign',
          created_at: new Date().toISOString(),
        }
      )
    );
    installedId = record.nhi_id;
    return record;
  }
  const approve = (id: string, decision: 'approved' | 'rejected' = 'approved') =>
    run(() => {
      const record = approvals.loadApprovalRequest(api.ONBOARDING_AUTHORITY_CHANNEL, id)!;
      return approvals.decideApprovalRequest('mission_controller', {
        channel: record.channel,
        requestId: id,
        decision,
        decidedBy: verified.principal.actor.id,
        decidedByRole: 'owner',
        decidedByType: 'human',
        authenticated: true,
        authMethod: 'surface_session',
        deciderPrincipal: verified.principal,
        presentedDigest: approvals.computeApprovalPresentedDigest(record),
        payloadHash: record.accountability?.payloadHash,
        effectBinding: record.accountability?.effectBinding,
      });
    });
  return {
    root,
    principal,
    input,
    run,
    request,
    approve,
    installAgent,
    governIdentity: <T>(body: () => T): T =>
      authority.withExecutionContext('mission_controller', body),
    get identities() {
      return identities;
    },
    get installedId() {
      return installedId;
    },
    get api() {
      return api;
    },
    get approvals() {
      return approvals;
    },
    get charters() {
      return charters;
    },
    get members() {
      return members;
    },
    get viewer() {
      return verified;
    },
  };
}
