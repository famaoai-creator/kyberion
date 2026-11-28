import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  identity: vi.fn(),
  envelope: vi.fn(),
  resource: vi.fn(),
  plugin: vi.fn(),
  delegated: vi.fn(),
  local: vi.fn(),
  installed: vi.fn(),
  owner: vi.fn(),
  requester: vi.fn(),
  authenticate: vi.fn(),
  collect: vi.fn(),
  pipe: vi.fn(),
  read: vi.fn(),
  path: vi.fn(),
  stat: vi.fn(),
  request: vi.fn(),
  apply: vi.fn(),
  revoke: vi.fn(),
  mediationDepth: 0,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: (_role: string, run: () => unknown) => run(),
}));
vi.mock('@agent/core/secure-io', () => ({
  assertSafeRepositoryPath: m.path,
  safeLstat: m.stat,
  withSensitivePathMediation: (run: () => unknown) => {
    m.mediationDepth++;
    try {
      return run();
    } finally {
      m.mediationDepth--;
    }
  },
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => '/repo/knowledge/personal',
}));
vi.mock('@agent/core/scope-envelope', () => ({ currentScopeEnvelope: m.envelope }));
vi.mock('@agent/core/foundation/credential-binding', () => ({
  credentialExecutionIdentity: m.identity,
}));
vi.mock('@agent/core/foundation/resource-access-scope', () => ({
  currentResourceAccessScope: m.resource,
}));
vi.mock('@agent/core/shell/sandbox-policy', () => ({ getPluginExecutionContext: m.plugin }));
vi.mock('@agent/core/governance/delegated-execution', () => ({
  hasDelegatedExecutionContext: m.delegated,
}));
vi.mock('@agent/core/foundation/secret-resolution-session', () => ({
  withSecretResolutionSession: (run: () => unknown) => run(),
}));
vi.mock('@agent/core/authn-principal-resolver', () => ({
  resolveAuthnPrincipal: m.authenticate,
}));
vi.mock('@agent/core/authn/authn-providers', () => ({}));
vi.mock('@agent/core/organization/onboarding-runtime-identity', () => ({
  inspectInstalledOnboardingRuntime: m.installed,
}));
vi.mock('@agent/core/governance/cli-operator-principal', () => ({
  resolveCliOperatorIdentity: m.owner,
  resolveCliApprovalRequester: m.requester,
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  computeApprovalPayloadHash: (value: unknown) => JSON.stringify(value),
}));
vi.mock('@agent/core/governance/personal-credential-grant', () => ({
  requestPersonalCredentialGrantApproval: m.request,
  grantPersonalCredentialUse: m.apply,
  revokePersonalCredentialGrant: m.revoke,
}));
vi.mock('./lib/installed-identity.js', () => ({ inspectInstalledIdentity: m.local }));
vi.mock('./lib/json-input.js', () => ({ readSafeJsonFile: m.read }));
vi.mock('./lib/tty/hidden-token-input.js', () => ({ readHiddenToken: m.collect }));
vi.mock('./lib/tty/private-token-pipe.js', () => ({ readPrivateTokenPipe: m.pipe }));

import { main, runPersonalCredentialConsentCli } from './personal_credential_consent.js';

const nhi = 'kyberion://agent/_/_/personal-assistant';
const file = '/repo/knowledge/personal/selection.json';
const selection = {
  bindingId: 'personal-slack',
  projectId: 'project-a',
  missionId: 'MSN-A',
  taskId: 'task-a',
  allowedActions: ['auth_test'],
  purpose: 'Synthetic selection',
  ttlDays: 1,
};
const principal = {
  provider: 'agent-token',
  source: 'agent',
  assurance: 'high',
  actor: { kind: 'agent', id: nhi, on_behalf_of: 'user:owner' },
  tenantSlugs: [],
  expiresAt: '2099-01-01T00:00:00Z',
};
const owner = {
  requesterId: nhi,
  accountableId: 'user:owner',
  personalOwner: true,
  tenantSlugs: [],
};
const request = ['request', '--selection', file];
beforeEach(() => {
  vi.resetAllMocks();
  m.mediationDepth = 0;
  m.identity.mockReturnValue({});
  m.owner.mockReturnValue({ principalId: 'user:owner' });
  m.local.mockReturnValue({ ready: true, source: 'local' });
  m.installed.mockReturnValue({
    ready: true,
    agentActive: true,
    ownerId: 'user:owner',
    agentId: nhi,
  });
  m.authenticate.mockReturnValue({ principal });
  m.collect.mockResolvedValue('synthetic-workload-token');
  m.pipe.mockResolvedValue('synthetic-workload-token');
  m.read.mockImplementation(() => ({
    ...selection,
    allowedActions: [...selection.allowedActions],
  }));
  m.path.mockImplementation((value: string) => value);
  m.stat.mockReturnValue({ isFile: () => true, size: 400 });
  m.requester.mockReturnValue({ source: 'operator', actorId: 'user:owner' });
  m.request.mockReturnValue({ id: 'approval-1', status: 'pending', channel: 'grant-standing' });
  m.apply.mockReturnValue({ grant_id: 'grant-1', expires_at: '2099-01-01T00:00:00Z' });
  m.revoke.mockReturnValue({ grant_id: 'grant-1' });
});

describe('personal credential consent CLI', () => {
  it('uses the explicit pipe without TTY fallback and keeps input outside sensitive mediation', async () => {
    m.pipe.mockImplementation(async () => {
      expect(m.mediationDepth).toBe(0);
      return 'synthetic-workload-token';
    });
    await runPersonalCredentialConsentCli([...request, '--token-pipe']);
    expect(m.pipe).toHaveBeenCalledOnce();
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.authenticate).toHaveBeenCalledTimes(2);
    m.pipe.mockRejectedValueOnce(Error('Private pipe cancelled'));
    m.request.mockClear();
    await expect(runPersonalCredentialConsentCli([...request, '--token-pipe'])).rejects.toThrow(
      'cancelled'
    );
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.request).not.toHaveBeenCalled();
  });

  it.each(['envelope', 'resource', 'plugin', 'delegated'] as const)(
    'rejects the %s ceiling before opening the private pipe',
    async (context) => {
      m[context].mockReturnValue({});
      await expect(runPersonalCredentialConsentCli([...request, '--token-pipe'])).rejects.toThrow(
        'unscoped'
      );
      expect(m.pipe).not.toHaveBeenCalled();
    }
  );

  it('rechecks host and installed identity boundaries after pipe input', async () => {
    m.pipe.mockImplementationOnce(async () => {
      m.delegated.mockReturnValue(true);
      return 'synthetic-workload-token';
    });
    await expect(runPersonalCredentialConsentCli([...request, '--token-pipe'])).rejects.toThrow(
      'unscoped'
    );
    expect(m.request).not.toHaveBeenCalled();
    m.delegated.mockReturnValue(false);
    m.pipe.mockImplementationOnce(async () => {
      m.installed.mockReturnValue({
        ready: true,
        agentActive: true,
        ownerId: 'user:other',
        agentId: nhi,
      });
      return 'synthetic-workload-token';
    });
    await expect(runPersonalCredentialConsentCli([...request, '--token-pipe'])).rejects.toThrow(
      'authentication refused'
    );
    expect(m.request).not.toHaveBeenCalled();
  });

  it('mediates synchronous sensitive reads and writes without spanning terminal input', async () => {
    m.collect.mockImplementation(async () => {
      expect(m.mediationDepth).toBe(0);
      return 'synthetic-workload-token';
    });
    m.read.mockImplementation(() => {
      expect(m.mediationDepth).toBeGreaterThan(0);
      return selection;
    });
    m.authenticate.mockImplementation(() => {
      expect(m.mediationDepth).toBeGreaterThan(0);
      return { principal };
    });
    m.request.mockImplementation(() => {
      expect(m.mediationDepth).toBeGreaterThan(0);
      return { id: 'approval-1', status: 'pending', channel: 'grant-standing' };
    });
    await runPersonalCredentialConsentCli(request);
    expect(m.mediationDepth).toBe(0);
  });

  it('derives the requester from existing agent-token authentication only', async () => {
    const print = vi.fn();
    await main([...request, '--json'], print);
    expect(m.authenticate).toHaveBeenCalledTimes(2);
    expect(m.authenticate).toHaveBeenCalledWith(
      { credential: { type: 'agent-token', token: 'synthetic-workload-token' } },
      { providerIds: ['agent-token'], pin: false }
    );
    expect(m.request).toHaveBeenCalledWith(owner, selection);
    expect(m.requester).not.toHaveBeenCalled();
    expect(print).toHaveBeenCalledWith({
      approval_id: 'approval-1',
      status: 'pending',
      approval_url: '/?approvalId=approval-1&approvalChannel=grant-standing',
    });
    expect(JSON.stringify(print.mock.calls)).not.toContain('synthetic-workload-token');
  });

  it('passes the exact selection and approval to issuance, without deciding approval', async () => {
    expect(
      await runPersonalCredentialConsentCli([
        'apply',
        '--selection',
        file,
        '--approval-id',
        'approval-1',
      ])
    ).toEqual({ grant_id: 'grant-1', status: 'granted', expires_at: '2099-01-01T00:00:00Z' });
    expect(m.apply).toHaveBeenCalledWith(owner, selection, 'approval-1');
    expect(m.request).not.toHaveBeenCalled();
  });

  it.each([
    { ...principal, provider: 'agent-context' },
    { ...principal, source: 'loopback' },
    { ...principal, assurance: 'low' },
    { ...principal, actor: { kind: 'human', id: 'user:owner' } },
    { ...principal, actor: { ...principal.actor, id: 'kyberion://agent/_/_/other' } },
    { ...principal, actor: { ...principal.actor, on_behalf_of: 'user:other' } },
    { ...principal, actor: { ...principal.actor, on_behalf_of: undefined } },
    { ...principal, tenantSlugs: ['tenant-a'] },
    { ...principal, tenantSlugs: 'all' },
    { ...principal, expiresAt: '2000-01-01T00:00:00Z' },
    { ...principal, expiresAt: 'invalid' },
  ])('refuses a weaker, foreign or expired resolved principal', async (value) => {
    m.authenticate.mockReturnValue({ principal: value });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow(
      'authentication refused'
    );
    expect(m.request).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('does not replace failed token authentication with an agent requester marker', async () => {
    m.requester.mockReturnValue({ source: 'agent', actorId: nhi });
    m.authenticate.mockImplementation(() => {
      throw Error('synthetic-workload-token');
    });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow(
      'Agent authentication refused'
    );
    await expect(runPersonalCredentialConsentCli(request)).rejects.not.toThrow(
      'synthetic-workload-token'
    );
    expect(m.requester).not.toHaveBeenCalled();
    expect(m.request).not.toHaveBeenCalled();
  });

  it('revalidates authentication after selection input and before any write', async () => {
    m.authenticate.mockReturnValueOnce({ principal }).mockImplementationOnce(() => {
      throw Error('expired');
    });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow(
      'authentication refused'
    );
    expect(m.read).toHaveBeenCalledTimes(2);
    expect(m.request).not.toHaveBeenCalled();
  });

  it('refuses selection drift during interactive authentication', async () => {
    m.read.mockReturnValueOnce(selection).mockReturnValueOnce({ ...selection, taskId: 'other' });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('Selection changed');
    expect(m.request).not.toHaveBeenCalled();
  });

  it.each([{ ready: false }, { ready: true, source: 'installation' }])(
    'refuses nonlocal or absent installation before collecting a token',
    async (local) => {
      m.local.mockReturnValue(local);
      await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow(
        'installed owner checkout'
      );
      expect(m.collect).not.toHaveBeenCalled();
    }
  );

  it('refuses changed installed identity after interactive input', async () => {
    m.collect.mockImplementation(async () => {
      m.installed.mockReturnValue({
        ready: true,
        agentActive: true,
        ownerId: 'user:owner',
        agentId: 'kyberion://agent/_/_/other',
      });
      return 'synthetic-workload-token';
    });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow(
      'authentication refused'
    );
    expect(m.request).not.toHaveBeenCalled();
  });

  it.each([
    { tenantSlug: 'tenant-a' },
    { missionId: 'MSN-A' },
    { taskId: 'task-a' },
    { personalClaim: { actorId: nhi } },
  ])('rejects ambient scoped execution before identity or input work', async (identity) => {
    m.identity.mockReturnValue(identity);
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('unscoped');
    expect(m.owner).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it.each(['envelope', 'resource', 'plugin', 'delegated'] as const)(
    'rejects the %s ceiling before input',
    async (context) => {
      m[context].mockReturnValue({});
      await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('unscoped');
      expect(m.collect).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ...selection, token: 'synthetic-workload-token' },
    { ...selection, ownerId: 'user:other' },
    { ...selection, allowedActions: ['auth_test', 'auth_test'] },
    { ...selection, ttlDays: 1.5 },
    { ...selection, purpose: '' },
    { ...selection, taskId: '../other' },
  ])('rejects malformed or authority-bearing selection before token input', async (value) => {
    m.read.mockReturnValue(value);
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('Invalid selection');
    expect(m.collect).not.toHaveBeenCalled();
  });

  it('rejects files outside the profile or above the byte limit', async () => {
    await expect(
      runPersonalCredentialConsentCli(['request', '--selection', '/repo/public/x.json'])
    ).rejects.toThrow('file boundary');
    m.stat.mockReturnValue({ isFile: () => true, size: 16385 });
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('file boundary');
    expect(m.collect).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['request', '--selection', file, '--selection', file],
      ['request', '--selection', file, '--token', 'synthetic-workload-token'],
      ['request', '--selection', file, '--owner', 'user:other'],
      ['request', '--selection', file, '--requested-by', nhi],
      ['apply', '--selection', file],
      ['approve', 'approval-1'],
      ['revoke', 'grant-1'],
      ['revoke', 'grant-1', '--reason', 'Withdraw', '--token-pipe'],
      ['request', '--selection', file, '--token-pipe', '--token-pipe'],
      ['request', '--selection', file, '--token-pipe=4'],
      ['request', '--selection', file, '--token-fd', '4'],
    ].map((args) => ({ args }))
  )('rejects unsupported, duplicate or incomplete arguments', async ({ args }) => {
    await expect(runPersonalCredentialConsentCli(args)).rejects.toThrow('[PERSONAL_CONSENT_CLI]');
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.request).not.toHaveBeenCalled();
    expect(m.pipe).not.toHaveBeenCalled();
  });

  it('cancellation collects no approval or grant', async () => {
    m.collect.mockRejectedValue(Error('Input cancelled'));
    await expect(runPersonalCredentialConsentCli(request)).rejects.toThrow('cancelled');
    expect(m.authenticate).not.toHaveBeenCalled();
    expect(m.request).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('lets the registered owner withdraw after the installed agent becomes unavailable', async () => {
    m.local.mockReturnValue({ ready: false });
    m.installed.mockReturnValue({ ready: false });
    expect(
      await runPersonalCredentialConsentCli(['revoke', 'grant-1', '--reason', 'Withdraw'])
    ).toEqual({
      grant_id: 'grant-1',
      status: 'revoked',
      verification: {
        usage_grant: 'revoked',
        credential_registration: 'not_checked',
        provider_revocation: 'not_checked',
      },
    });
    expect(m.revoke).toHaveBeenCalledWith(
      { ...owner, requesterId: 'user:owner' },
      'grant-1',
      'Withdraw'
    );
    expect(m.local).not.toHaveBeenCalled();
    expect(m.installed).not.toHaveBeenCalled();
    expect(m.collect).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'agent', actorId: nhi },
    { source: 'legacy', actorId: 'user:owner' },
    { source: 'operator', actorId: 'user:other' },
  ])('refuses withdrawal under a different operator', async (requester) => {
    m.requester.mockReturnValue(requester);
    await expect(
      runPersonalCredentialConsentCli(['revoke', 'grant-1', '--reason', 'Withdraw'])
    ).rejects.toThrow('local owner');
    expect(m.revoke).not.toHaveBeenCalled();
  });
});
