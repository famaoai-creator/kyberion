import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { humanActor } from '@agent/core/actor';
import type { PasskeyCredentialFile } from '@agent/core/authn/passkey-credential-store';

/**
 * The session binding recorded at `step_up_verify` must be the one the
 * installation write gate checks later — for a session cookie and for a
 * bearer credential. The gate, the binding derivation, the step-up spend and
 * the record are all real; only WebAuthn signature checking, the viewer
 * transport and file storage are replaced (in memory, hermetic).
 */
const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
}));

vi.mock('@agent/core/authn/passkey-credential-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/authn/passkey-credential-store')>();
  const read = (memberId: string) =>
    (state.files.get(memberId) as PasskeyCredentialFile | undefined) ?? null;
  return {
    ...actual,
    readPasskeyCredentialFile: read,
    listPasskeyCredentials: (memberId: string) => read(memberId)?.credentials ?? [],
    updatePasskeyCredentialFile: <T>(
      memberId: string,
      _options: unknown,
      fn: (current: PasskeyCredentialFile) => { next?: PasskeyCredentialFile; result: T }
    ): T => {
      const current = structuredClone(read(memberId)!);
      const { next, result } = fn(current);
      if (next) state.files.set(memberId, structuredClone(next));
      return result;
    },
  };
});
vi.mock('@agent/core/authn/webauthn-verifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/authn/webauthn-verifier')>();
  const stepUp = await import('@agent/core/authn/passkey-step-up');
  return {
    ...actual,
    createPasskeyStepUpOptions: async (params: { memberId: string; purpose: 'installation' }) => {
      stepUp.issuePasskeyStepUp(params.memberId, { purpose: params.purpose });
      return { challenge: 'test' };
    },
    // The assertion signature is trusted here; claim/verify/token are real.
    verifyPasskeyStepUp: async (params: { memberId: string }) => {
      const claimed = stepUp.claimPasskeyStepUp(params.memberId);
      const token = stepUp.markPasskeyStepUpVerified(params.memberId, claimed, 'cred-1');
      return { purpose: claimed.purpose, credentialId: 'cred-1', stepUpToken: token };
    },
  };
});
vi.mock('@agent/core/organization/member-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/member-registry')>()),
  readMemberProfile: (id: string) =>
    id === 'owner' ? { member_id: 'owner', status: 'active' } : null,
}));
vi.mock('@agent/core/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/authority')>()),
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
  withExecutionContextAsync: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/loopback-peer', () => ({
  isLoopbackPeer: () => false,
  conciergePeerAddress: () => null,
}));
const owner = {
  role: 'localadmin',
  source: 'token',
  principalId: 'dev-user',
  memberId: 'owner',
  tenantSlugs: ['default'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public', 'confidential'],
  principal: {
    actor: humanActor('owner'),
    principalId: 'dev-user',
    role: 'localadmin',
    tenantSlugs: ['default'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'oidc',
    provider: 'browser-session',
    assurance: 'high',
    memberId: 'owner',
  },
};
vi.mock('../src/lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: owner }),
  conciergeErrorResponse: (error: unknown, status = 500) =>
    new Response(JSON.stringify({ ok: false, error: String(error) }), { status }),
}));
vi.mock('../src/lib/passkey-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/passkey-server')>()),
  conciergePasskeyMember: () => ({
    memberId: 'owner',
    displayName: 'Owner',
    decidedBy: 'user:owner',
  }),
  conciergeRelyingParty: () => ({ rpId: 'localhost', origin: 'https://c.example', rpName: 'K' }),
  passkeyRateLimited: () => null,
  passkeyEnrollmentDenied: () => null,
  reportInstallationStepUp: () => undefined,
}));

import { POST as passkeys } from '../src/app/api/me/passkeys/route';
import { resolveOperatorServiceAccess } from '../src/lib/operator-service-access';

const credential = {
  cookie: (token: string) => ({ cookie: `kyberion_session=kys1.${token}.sig` }),
  bearer: (token: string) => ({ authorization: `Bearer ${token}` }),
};
function req(path: string, headers: Record<string, string>, body?: unknown) {
  return new NextRequest(`https://c.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  state.files.clear();
  state.files.set('owner', {
    version: 1,
    member_id: 'owner',
    user_handle: 'aGFuZGxl',
    credentials: [
      {
        credential_id: 'cred-1',
        public_key: 'cGs',
        counter: 0,
        label: 'Laptop',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
});

describe.each(['cookie', 'bearer'] as const)('installation step-up binding (%s)', (kind) => {
  it('admits the later remote write only from the session that confirmed', async () => {
    const as = credential[kind];
    const before = resolveOperatorServiceAccess(req('/api/services/operator', as('session-a')));
    expect(before.response?.status).toBe(403);

    const started = await passkeys(
      req('/api/me/passkeys', as('session-a'), {
        action: 'step_up_options',
        purpose: 'installation',
      })
    );
    expect(started.status).toBe(200);
    const verified = await passkeys(
      req('/api/me/passkeys', as('session-a'), {
        action: 'step_up_verify',
        response: { id: 'cred-1' },
      })
    );
    const verifiedBody = await verified.json();
    expect(verifiedBody, JSON.stringify(verifiedBody)).toMatchObject({
      ok: true,
      purpose: 'installation',
    });

    const same = resolveOperatorServiceAccess(req('/api/services/operator', as('session-a')));
    expect(same.response).toBeUndefined();
    expect(same.principal?.installationGrant).toMatchObject({ stepUp: true, transport: 'remote' });

    const other = resolveOperatorServiceAccess(req('/api/services/operator', as('session-b')));
    expect(other.response?.status).toBe(403);
    expect(await other.response!.json()).toEqual({
      ok: false,
      error: 'installation_step_up_required',
    });
  });
});
