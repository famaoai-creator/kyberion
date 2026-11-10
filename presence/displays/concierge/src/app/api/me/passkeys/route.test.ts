import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { agentExecutionContextEnvNames } from '@agent/core/agent-execution-context';

const mocks = vi.hoisted(() => ({
  createPasskeyRegistrationOptions: vi.fn(),
  verifyPasskeyRegistration: vi.fn(),
  createPasskeyStepUpOptions: vi.fn(),
  verifyPasskeyStepUp: vi.fn(),
  revokeMemberPasskey: vi.fn(),
  listPasskeyCredentials: vi.fn(),
  passkeyStepUpRequired: vi.fn(),
  auditRecord: vi.fn(),
  notifyOperator: vi.fn(),
  member: vi.fn(),
  rp: vi.fn(),
  rateLimited: vi.fn(),
  viewer: vi.fn(),
  installation: vi.fn(),
  loopback: vi.fn(),
  recordInstallationStepUp: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({ context: mocks.viewer() })),
  conciergeErrorResponse: vi.fn(
    (error: unknown, status: number) =>
      new Response(JSON.stringify({ ok: false, error: String(error) }), { status })
  ),
}));
vi.mock('../../../../lib/passkey-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/passkey-server')>(
    '../../../../lib/passkey-server'
  );
  return {
    ...actual,
    conciergePasskeyMember: mocks.member,
    conciergeRelyingParty: mocks.rp,
    passkeyRateLimited: mocks.rateLimited,
  };
});
vi.mock('@agent/core/authority', () => ({
  // S4: store facades open their declared store grant (withStoreGrant).
  withStoreGrant: (_name: string, fn: () => unknown) => fn(),
  withStoreGrantAsync: async (_name: string, fn: () => unknown) => fn(),
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
  withExecutionContextAsync: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/authn/webauthn-verifier', () => ({
  createPasskeyRegistrationOptions: mocks.createPasskeyRegistrationOptions,
  verifyPasskeyRegistration: mocks.verifyPasskeyRegistration,
  createPasskeyStepUpOptions: mocks.createPasskeyStepUpOptions,
  verifyPasskeyStepUp: mocks.verifyPasskeyStepUp,
  revokeMemberPasskey: mocks.revokeMemberPasskey,
}));
vi.mock('@agent/core/authn/passkey-credential-store', () => ({
  listPasskeyCredentials: mocks.listPasskeyCredentials,
}));
vi.mock('@agent/core/authn/passkey-step-up', () => ({
  passkeyStepUpRequired: mocks.passkeyStepUpRequired,
}));
vi.mock('../../../../lib/installation-access', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/installation-access')>(
    '../../../../lib/installation-access'
  );
  return {
    ...actual,
    resolveConciergeInstallationAccess: mocks.installation,
    conciergeSessionBinding: () => 'session-binding',
  };
});
vi.mock('../../../../lib/loopback-peer', () => ({ isLoopbackPeer: mocks.loopback }));
vi.mock('@agent/core/authn/installation-step-up', () => ({
  recordInstallationStepUp: mocks.recordInstallationStepUp,
}));
vi.mock('@agent/core/governance/audit-chain', () => ({
  auditChain: { record: mocks.auditRecord },
}));
vi.mock('@agent/core/surface/operator-notifications', () => ({
  notifyOperator: mocks.notifyOperator,
}));

import { GET, POST } from './route.js';

function request(body?: unknown): NextRequest {
  return {
    url: 'https://concierge.example/api/me/passkeys',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}
const rp = { rpId: 'concierge.example', origin: 'https://concierge.example', rpName: 'Kyberion' };

function viewer(principal?: {
  provider: string;
  actor: { kind: string; id: string };
  source: string;
}) {
  return {
    role: 'member',
    tenantSlugs: ['acme'],
    source: principal ? 'token' : 'loopback',
    ...(principal ? { principal: { ...principal, principalId: principal.actor.id } } : {}),
  };
}
const browserSession = viewer({
  provider: 'browser-session',
  actor: { kind: 'human', id: 'user:carol' },
  source: 'session',
});

describe('concierge /api/me/passkeys (HA-07)', () => {
  beforeEach(() => {
    for (const name of agentExecutionContextEnvNames()) vi.stubEnv(name, undefined);
    vi.stubEnv('SYSTEM_ROLE', undefined);
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.viewer.mockReturnValue(browserSession);
    mocks.member.mockReturnValue({
      memberId: 'carol',
      displayName: 'Carol',
      decidedBy: 'user:carol',
    });
    mocks.rp.mockReturnValue(rp);
    mocks.rateLimited.mockReturnValue(null);
    mocks.notifyOperator.mockResolvedValue(true);
    mocks.passkeyStepUpRequired.mockReturnValue(false);
    mocks.loopback.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists only the viewer member’s passkeys and whether a change needs a step-up', async () => {
    mocks.listPasskeyCredentials.mockReturnValue([
      { credential_id: 'cred-1', label: 'Laptop', created_at: '2026-10-10T00:00:00.000Z' },
    ]);
    mocks.passkeyStepUpRequired.mockReturnValue(true);
    const response = GET(request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      member: boolean;
      passkeys: unknown[];
      step_up_required: boolean;
    };
    expect(body.member).toBe(true);
    expect(body.passkeys).toHaveLength(1);
    expect(body.step_up_required).toBe(true);
    expect(mocks.listPasskeyCredentials).toHaveBeenCalledWith('carol');
  });

  it('reports no member (and lists nothing) for a non-member credential', async () => {
    mocks.member.mockReturnValue(null);
    const body = (await GET(request()).json()) as { member: boolean; passkeys: unknown[] };
    expect(body).toEqual({ ok: true, member: false, passkeys: [], step_up_required: false });
    expect(mocks.listPasskeyCredentials).not.toHaveBeenCalled();
  });

  it('registers for the server-resolved member, audits it and notifies the operator', async () => {
    mocks.createPasskeyRegistrationOptions.mockResolvedValue({ challenge: 'abc' });
    const started = await POST(request({ action: 'options' }));
    expect(started.status).toBe(200);
    expect(mocks.createPasskeyRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'carol', rp })
    );

    mocks.verifyPasskeyRegistration.mockResolvedValue({
      credential_id: 'cred-1',
      label: 'Laptop',
      created_at: '2026-10-10T00:00:00.000Z',
      usable_after: '2026-10-11T00:00:00.000Z',
    });
    const done = await POST(
      request({ action: 'verify', response: { id: 'cred-1' }, label: 'Laptop' })
    );
    expect(done.status).toBe(200);
    expect(mocks.verifyPasskeyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'carol', label: 'Laptop', rp })
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'user:carol',
        operation: 'register',
        metadata: {
          credentialId: 'cred-1',
          steppedUp: false,
          usableAfter: '2026-10-11T00:00:00.000Z',
        },
      })
    );
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      'ops_alert',
      expect.objectContaining({
        title: 'Passkey added',
        body: expect.stringMatching(
          /not confirmed with an existing passkey.*enrollment cooldown.*from 2026-10-11T00:00:00\.000Z/u
        ),
      })
    );
  });

  it('refuses an agent principal before touching the passkey store', async () => {
    mocks.viewer.mockReturnValue(
      viewer({
        provider: 'agent-token',
        actor: { kind: 'agent', id: 'agent:planner' },
        source: 'agent',
      })
    );
    for (const action of ['options', 'verify', 'revoke', 'step_up_options']) {
      const response = await POST(
        request({ action, response: { id: 'x' }, credential_id: 'cred-1', purpose: 'enroll' })
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error_code: string }).error_code).toBe('agent_refused');
    }
    expect(mocks.createPasskeyRegistrationOptions).not.toHaveBeenCalled();
    expect(mocks.verifyPasskeyRegistration).not.toHaveBeenCalled();
    expect(mocks.revokeMemberPasskey).not.toHaveBeenCalled();
    expect(mocks.createPasskeyStepUpOptions).not.toHaveBeenCalled();
  });

  it('refuses a registry bearer token and a credential-less loopback viewer', async () => {
    mocks.viewer.mockReturnValue(
      viewer({
        provider: 'registry-token',
        actor: { kind: 'human', id: 'user:carol' },
        source: 'token',
      })
    );
    const bearer = await POST(request({ action: 'options' }));
    expect(bearer.status).toBe(403);
    expect(((await bearer.json()) as { error_code: string }).error_code).toBe('session_required');

    mocks.viewer.mockReturnValue(
      viewer({
        provider: 'loopback-local',
        actor: { kind: 'human', id: 'user:carol' },
        source: 'loopback',
      })
    );
    expect((await POST(request({ action: 'revoke', credential_id: 'cred-1' }))).status).toBe(403);
    mocks.viewer.mockReturnValue(viewer());
    expect((await POST(request({ action: 'options' }))).status).toBe(403);
    expect(mocks.createPasskeyRegistrationOptions).not.toHaveBeenCalled();
    expect(mocks.revokeMemberPasskey).not.toHaveBeenCalled();
  });

  it('maps a missing step-up (a usable passkey already exists) to 403', async () => {
    mocks.createPasskeyRegistrationOptions.mockRejectedValue(
      new Error(
        '[POLICY_VIOLATION] passkey step-up refused — changing passkeys needs a confirmation with a usable passkey (enroll)'
      )
    );
    expect((await POST(request({ action: 'options' }))).status).toBe(403);
    mocks.revokeMemberPasskey.mockImplementation(() => {
      throw new Error(
        '[POLICY_VIOLATION] passkey step-up refused — changing passkeys needs a confirmation with a usable passkey (revoke)'
      );
    });
    expect((await POST(request({ action: 'revoke', credential_id: 'cred-1' }))).status).toBe(403);
    expect(mocks.notifyOperator).not.toHaveBeenCalled();
  });

  it('runs the step-up ceremony for a revoke, bound to the credential', async () => {
    mocks.createPasskeyStepUpOptions.mockResolvedValue({ challenge: 'step' });
    expect((await POST(request({ action: 'step_up_options', purpose: 'revoke' }))).status).toBe(
      400
    );
    const started = await POST(
      request({ action: 'step_up_options', purpose: 'revoke', credential_id: 'cred-2' })
    );
    expect(started.status).toBe(200);
    expect(mocks.createPasskeyStepUpOptions).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'carol', purpose: 'revoke', target: 'cred-2', rp })
    );
    mocks.verifyPasskeyStepUp.mockResolvedValue({
      purpose: 'revoke',
      target: 'cred-2',
      credentialId: 'cred-1',
      stepUpToken: 'token-a',
    });
    const confirmed = await POST(request({ action: 'step_up_verify', response: { id: 'cred-1' } }));
    expect(await confirmed.json()).toEqual({
      ok: true,
      purpose: 'revoke',
      credential_id: 'cred-2',
      step_up_token: 'token-a',
    });
    mocks.revokeMemberPasskey.mockReturnValue({
      credentialId: 'cred-2',
      steppedUpWith: 'cred-1',
      wasCoolingDown: false,
    });
    await POST(request({ action: 'revoke', credential_id: 'cred-2', step_up_token: 'token-a' }));
    expect(mocks.revokeMemberPasskey).toHaveBeenCalledWith({
      memberId: 'carol',
      credentialId: 'cred-2',
      stepUpToken: 'token-a',
    });
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      'ops_alert',
      expect.objectContaining({
        body: expect.stringContaining('confirmed with an existing passkey'),
      })
    );
    expect((await POST(request({ action: 'step_up_options', purpose: 'other' }))).status).toBe(400);
  });

  it('revokes via the member-scoped revoke, notifies, and 404s an unknown passkey', async () => {
    mocks.revokeMemberPasskey
      .mockReturnValueOnce({ credentialId: 'cred-1', wasCoolingDown: true })
      .mockReturnValueOnce(null);
    expect((await POST(request({ action: 'revoke', credential_id: 'cred-1' }))).status).toBe(200);
    expect(mocks.revokeMemberPasskey).toHaveBeenCalledWith({
      memberId: 'carol',
      credentialId: 'cred-1',
      stepUpToken: undefined,
    });
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'revoke',
        metadata: { credentialId: 'cred-1', steppedUp: false, wasCoolingDown: true },
      })
    );
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      'ops_alert',
      expect.objectContaining({
        title: 'Passkey removed',
        body: expect.stringMatching(/signed-in session only.*still in its enrollment cooldown/u),
      })
    );
    expect((await POST(request({ action: 'revoke', credential_id: 'nope' }))).status).toBe(404);
  });

  it('passes the step-up token through to options and verify, and reports the confirming passkey', async () => {
    mocks.createPasskeyRegistrationOptions.mockResolvedValue({ challenge: 'abc' });
    await POST(request({ action: 'options', step_up_token: 'token-a' }));
    expect(mocks.createPasskeyRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'carol', stepUpToken: 'token-a' })
    );
    mocks.verifyPasskeyRegistration.mockResolvedValue({
      credential_id: 'cred-2',
      label: 'Phone',
      created_at: '2026-10-10T00:00:00.000Z',
      enrolled_with: 'cred-1',
    });
    await POST(request({ action: 'verify', response: { id: 'cred-2' }, step_up_token: 'token-a' }));
    expect(mocks.verifyPasskeyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ stepUpToken: 'token-a' })
    );
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { credentialId: 'cred-2', steppedUp: true, steppedUpWith: 'cred-1' },
      })
    );
  });

  it('maps a step-up spent by another session to 403', async () => {
    mocks.createPasskeyRegistrationOptions.mockRejectedValue(
      new Error(
        '[POLICY_VIOLATION] passkey step-up refused — the step-up token is missing or belongs to another confirmation'
      )
    );
    expect((await POST(request({ action: 'options', step_up_token: 'stolen' }))).status).toBe(403);
    expect(mocks.notifyOperator).not.toHaveBeenCalled();
  });

  it('rejects a body naming another member', async () => {
    const response = await POST(request({ action: 'options', member_id: 'mallory' }));
    expect(response.status).toBe(400);
    expect(mocks.createPasskeyRegistrationOptions).not.toHaveBeenCalled();
  });

  it('maps a refused registration to 403 without auditing or notifying', async () => {
    mocks.verifyPasskeyRegistration.mockRejectedValue(
      new Error('[POLICY_VIOLATION] passkey verification failed — registration challenge expired')
    );
    const response = await POST(request({ action: 'verify', response: { id: 'cred-1' } }));
    expect(response.status).toBe(403);
    expect(mocks.auditRecord).not.toHaveBeenCalled();
    expect(mocks.notifyOperator).not.toHaveBeenCalled();
  });

  it('refuses mutations for a non-member and without a public origin', async () => {
    mocks.member.mockReturnValue(null);
    expect((await POST(request({ action: 'options' }))).status).toBe(403);
    mocks.member.mockReturnValue({
      memberId: 'carol',
      displayName: 'Carol',
      decidedBy: 'user:carol',
    });
    mocks.rp.mockReturnValue(null);
    expect((await POST(request({ action: 'options' }))).status).toBe(503);
  });

  it('applies the passkey rate limit', async () => {
    mocks.rateLimited.mockReturnValue(new Response('{}', { status: 429 }));
    expect((await POST(request({ action: 'options' }))).status).toBe(429);
    expect(mocks.createPasskeyRegistrationOptions).not.toHaveBeenCalled();
  });

  it('enrolls the installation owner’s first passkey only from a trusted loopback peer', async () => {
    mocks.member.mockReturnValue({
      memberId: 'owner',
      displayName: 'Owner',
      decidedBy: 'user:owner',
    });
    mocks.createPasskeyRegistrationOptions.mockResolvedValue({ challenge: 'c' });
    const remote = await POST(request({ action: 'options' }));
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({
      error: 'installation_owner_first_passkey_loopback_required',
    });
    expect((await POST(request({ action: 'verify', response: { id: 'x' } }))).status).toBe(403);
    expect(mocks.createPasskeyRegistrationOptions).not.toHaveBeenCalled();
    expect(mocks.verifyPasskeyRegistration).not.toHaveBeenCalled();
    // At the machine it is allowed; with a usable passkey, a remote enrollment
    // goes through the normal step-up path instead.
    mocks.loopback.mockReturnValue(true);
    expect((await POST(request({ action: 'options' }))).status).toBe(200);
    mocks.loopback.mockReturnValue(false);
    mocks.passkeyStepUpRequired.mockReturnValue(true);
    expect((await POST(request({ action: 'options', step_up_token: 't' }))).status).toBe(200);
    // Other members are unaffected.
    mocks.member.mockReturnValue({
      memberId: 'carol',
      displayName: 'Carol',
      decidedBy: 'user:carol',
    });
    mocks.passkeyStepUpRequired.mockReturnValue(false);
    expect((await POST(request({ action: 'options' }))).status).toBe(200);
  });

  it('refuses an installation step-up to anyone but the installation owner', async () => {
    mocks.installation.mockReturnValue({
      allowed: false,
      mode: 'read',
      status: 403,
      code: 'installation_owner_required',
      reason: 'x',
      transport: 'remote',
    });
    const refused = await POST(request({ action: 'step_up_options', purpose: 'installation' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'installation_owner_required' });
    expect(mocks.createPasskeyStepUpOptions).not.toHaveBeenCalled();
  });

  it('records a verified installation step-up server-side, bound to the session', async () => {
    mocks.installation.mockReturnValue({ allowed: true, mode: 'read' });
    mocks.member.mockReturnValue({
      memberId: 'owner',
      displayName: 'Owner',
      decidedBy: 'user:owner',
    });
    mocks.createPasskeyStepUpOptions.mockResolvedValue({ challenge: 'c' });
    const started = await POST(request({ action: 'step_up_options', purpose: 'installation' }));
    expect(started.status).toBe(200);
    expect(mocks.createPasskeyStepUpOptions).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'owner', purpose: 'installation' })
    );
    mocks.verifyPasskeyStepUp.mockResolvedValue({
      purpose: 'installation',
      credentialId: 'cred-1',
      stepUpToken: 'single-use-token',
    });
    mocks.recordInstallationStepUp.mockReturnValue({
      verifiedAt: '2026-11-04T00:00:00.000Z',
      expiresAt: '2026-11-04T00:05:00.000Z',
      credentialId: 'cred-1',
    });
    const confirmed = await POST(request({ action: 'step_up_verify', response: { id: 'cred-1' } }));
    const body = await confirmed.json();
    expect(body).toEqual({
      ok: true,
      purpose: 'installation',
      step_up_expires_at: '2026-11-04T00:05:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('single-use-token');
    expect(mocks.recordInstallationStepUp).toHaveBeenCalledWith('owner', {
      sessionBinding: 'session-binding',
      stepUpToken: 'single-use-token',
    });
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'user:owner', operation: 'installation_step_up' })
    );
    expect(mocks.notifyOperator).toHaveBeenCalledWith(
      'ops_alert',
      expect.objectContaining({ title: 'Installation settings unlocked' })
    );
  });
});
