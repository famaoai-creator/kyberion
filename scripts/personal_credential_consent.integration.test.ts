/** Real authentication, approval and grant stores; only terminal input is synthetic. */
import * as path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../tests/helpers/onboarding-authority-fixture.js';

const input = vi.hoisted(() => ({ read: vi.fn<() => Promise<string>>() }));
vi.mock('./lib/tty/hidden-token-input.js', () => ({ readHiddenToken: input.read }));
const f = useOnboardingAuthorityFixture();
const key = 'synthetic-consent-cli-workload-key-never-an-account-secret';
const generation = '12345678-1234-4123-8123-123456789abc';
const address = {
  bindingId: 'personal-slack',
  serviceId: 'slack',
  ownerKind: 'person' as const,
  ownerRef: 'user:owner',
};
const selection = {
  bindingId: address.bindingId,
  projectId: 'project-a',
  missionId: 'MSN-A',
  taskId: 'task-a',
  allowedActions: ['auth_test'],
  purpose: 'Synthetic CLI personal consent',
  ttlDays: 1,
};
async function setup() {
  for (const name of [
    'KYBERION_NHI_ID',
    'KYBERION_AGENT_ID',
    'KYBERION_RUN_ORIGIN',
    'KYBERION_TASK_ID',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_TENANT',
    'MISSION_ID',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_AGENT_TOKEN_SECRET', key);
  input.read.mockReset();
  const { runPersonalCredentialConsentCli: cli } = await import('./personal_credential_consent.js');
  const authn = await import('@agent/core/authn/authn-providers');
  const bindings = await import('@agent/core/service/service-binding-registry');
  const guard = await import('@agent/core/secret/secret-guard');
  const encryption = await import('@agent/core/secret/secret-encryption');
  const { writeJson } = await import('@agent/core/foundation/json');
  const io = await import('@agent/core/secure-io');
  const file = path.join(f.root, 'knowledge/personal/consent-selection.json');
  const writeSelection = (value: typeof selection = selection) =>
    f.run(() => writeJson(file, value));
  encryption.overrideSecretEncryptionKeyForTests(Buffer.alloc(32, 27));
  f.run(() => {
    writeJson(path.join(f.root, 'knowledge/personal/my-identity.json'), {
      name: 'Synthetic owner',
    });
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
    // Metadata only: no service token is stored or sent to a provider.
    guard.storeLocalAccountRegistration(address, { generation });
  });
  writeSelection();
  const issued = f.run(() => authn.issueAgentToken({ nhiId: f.installedId, ttlSeconds: 900 }));
  const { token, payload } = issued;
  input.read.mockResolvedValue(token);
  const request = async () => {
    const result = await cli(['request', '--selection', file]);
    expect(result).toMatchObject({ status: 'pending', approval_id: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(token);
    return (result as { approval_id: string }).approval_id;
  };
  const apply = async (id: string) => {
    const result = await cli(['apply', '--selection', file, '--approval-id', id]);
    expect(result).toMatchObject({ status: 'granted', grant_id: expect.any(String) });
    return (result as { grant_id: string }).grant_id;
  };
  return { cli, authn, guard, io, file, token, payload, request, apply, writeSelection };
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
afterEach(async () => {
  (await import('@agent/core/secret/secret-encryption')).overrideSecretEncryptionKeyForTests(null);
  for (const name of [
    'KYBERION_NHI_ID',
    'KYBERION_AGENT_ID',
    'KYBERION_RUN_ORIGIN',
    'KYBERION_TASK_ID',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_TENANT',
    'MISSION_ID',
  ])
    vi.stubEnv(name, '');
});

describe('personal credential consent CLI full chain', () => {
  it('authenticates the agent, requires the separate signed human decision and refuses replay', async () => {
    const x = await setup();
    vi.stubEnv('KYBERION_NHI_ID', 'kyberion://agent/_/_/untrusted-env-hint');
    const id = await x.request();
    const record = f.personal(() => f.approvals.loadApprovalRequest('grant-standing', id)!);
    expect(record.requestedBy).toBe(f.installedId);
    expect(record.requestedByContext?.actorId).toBe(f.installedId);
    await expect(x.apply(id)).rejects.toThrow();
    approve(id);
    const grant = await x.apply(id);
    await expect(x.apply(id)).rejects.toThrow();
    vi.stubEnv('KYBERION_NHI_ID', '');
    input.read.mockClear();
    await expect(
      x.cli(['revoke', grant, '--reason', 'Owner withdraws synthetic consent'])
    ).resolves.toEqual({ grant_id: grant, status: 'revoked' });
    expect(input.read).not.toHaveBeenCalled();
    expect(
      f.personal(() => f.approvals.loadApprovalRequest('grant-standing', id)?.revocation)
    ).toBeTruthy();
  }, 60000);

  it('rejects invalid, expired, foreign and tenant-bearing signed credentials without creating approval', async () => {
    const x = await setup();
    const foreign = f.governIdentity(() => {
      const issued = f.identities.issueAgentIdentity({
        kind: 'agent',
        slug: 'foreign-cli-agent',
        personScope: true,
        displayName: 'Synthetic other agent',
        accountableHumanId: 'user:owner',
      });
      return f.identities.activateAgentIdentity(issued.nhi_id).nhi_id;
    });
    // The public issuer now refuses owner/scope substitution. Independently sign
    // those malformed claims with the synthetic key to also exercise verification.
    expect(() =>
      f.run(() => x.authn.issueAgentToken({ nhiId: f.installedId, tenants: ['fixture-a'] }))
    ).toThrow();
    expect(() =>
      f.run(() => x.authn.issueAgentToken({ nhiId: f.installedId, onBehalfOf: 'user:other' }))
    ).toThrow();
    const signClaims = (claims: unknown) => {
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = createHmac('sha256', key).update(`kya1.${body}`).digest('base64url');
      return `kya1.${body}.${signature}`;
    };
    const legacy: Record<string, unknown> = { ...x.payload };
    delete legacy.identity_revision;
    const tokens = f.run(() => [
      'not-a-signed-workload-token',
      x.token.slice(0, -1) + (x.token.endsWith('A') ? 'B' : 'A'),
      x.authn.issueAgentToken({ nhiId: f.installedId, ttlSeconds: 1 }, { now: Date.now() - 10_000 })
        .token,
      x.authn.issueAgentToken({ nhiId: foreign }).token,
      signClaims({ ...x.payload, tenants: ['fixture-a'] }),
      signClaims({ ...x.payload, obo: 'user:other' }),
      signClaims(legacy),
    ]);
    for (const token of tokens) {
      input.read.mockResolvedValueOnce(token);
      await expect(x.request()).rejects.toThrow();
    }
    expect(f.personal(() => f.approvals.listApprovalRequests({ status: 'pending' }))).toEqual([]);
  }, 60000);

  it('never turns an environment marker into authentication and fails without an existing verification key', async () => {
    const x = await setup();
    vi.stubEnv('KYBERION_NHI_ID', f.installedId);
    input.read.mockResolvedValueOnce('owner-entered-marker-is-not-a-credential');
    await expect(x.request()).rejects.toThrow();
    vi.stubEnv('KYBERION_AGENT_TOKEN_SECRET', '');
    await expect(x.request()).rejects.toThrow();
    expect(f.personal(() => f.approvals.listApprovalRequests({ status: 'pending' }))).toEqual([]);
  });

  it('refuses unavailable installed identity before collecting a credential', async () => {
    const x = await setup();
    f.run(() => x.io.safeRmSync(path.join(f.root, 'knowledge/personal/my-identity.json')));
    await expect(x.request()).rejects.toThrow();
    expect(input.read).not.toHaveBeenCalled();
  });

  it('denies selection and account-generation drift without burning an otherwise current approval', async () => {
    const x = await setup();
    const id = await x.request();
    approve(id);
    x.writeSelection({ ...selection, taskId: 'other-task' });
    await expect(x.apply(id)).rejects.toThrow();
    x.writeSelection();
    f.run(() =>
      x.guard.storeLocalAccountRegistration(address, {
        generation: '22345678-1234-4123-8123-123456789abc',
      })
    );
    await expect(x.apply(id)).rejects.toThrow();
    expect(
      f.personal(() => f.approvals.loadApprovalRequest('grant-standing', id)?.consumption)
    ).toBeUndefined();
  }, 60000);

  it('detects selection replacement while the terminal is collecting the credential', async () => {
    const x = await setup();
    input.read.mockImplementationOnce(async () => {
      x.writeSelection({ ...selection, purpose: 'Changed while input was pending' });
      return x.token;
    });
    await expect(x.request()).rejects.toThrow();
    expect(f.personal(() => f.approvals.listApprovalRequests({ status: 'pending' }))).toEqual([]);
  });

  it.each(['profile-removed', 'suspended'] as const)(
    'allows owner withdrawal after the agent is %s',
    async (change) => {
      const x = await setup();
      const id = await x.request();
      approve(id);
      const grant = await x.apply(id);
      if (change === 'profile-removed')
        f.run(() => x.io.safeRmSync(path.join(f.root, 'knowledge/personal/agent-identity.json')));
      else
        f.governIdentity(() =>
          f.identities.suspendAgentIdentity(f.installedId, 'Synthetic suspension')
        );
      input.read.mockClear();
      await expect(
        x.cli(['revoke', grant, '--reason', 'Withdraw without an active assistant'])
      ).resolves.toEqual({ grant_id: grant, status: 'revoked' });
      expect(input.read).not.toHaveBeenCalled();
      const scope = await import('@agent/core/scope-envelope');
      const historical = scope.mintScopeEnvelope({
        identity: { tier: 'personal', nhi_id: f.installedId, session_id: 'synthetic-revoke-check' },
        policy: {
          purpose: 'verify historical withdrawal',
          read_tiers: ['personal', 'public'],
          write_tier: 'personal',
        },
        env: { ...process.env, KYBERION_TIER: 'personal' },
      });
      expect(
        f.run(() =>
          scope.withScopeEnvelope(
            historical,
            () => f.approvals.loadApprovalRequest('grant-standing', id)?.revocation
          )
        )
      ).toBeTruthy();
      await expect(x.cli(['revoke', grant, '--reason', 'Already withdrawn'])).rejects.toThrow();
    },
    60000
  );
});
