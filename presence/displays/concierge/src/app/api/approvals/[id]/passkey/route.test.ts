import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  loadApprovalRequest: vi.fn(),
  decideApprovalRequest: vi.fn(),
  createApprovalPasskeyOptions: vi.fn(),
  verifyApprovalPasskeyAssertion: vi.fn(),
  decisionDenied: vi.fn(),
  member: vi.fn(),
  rp: vi.fn(),
  rateLimited: vi.fn(),
}));

vi.mock('../../../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: vi.fn(() => null),
}));
vi.mock('../../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: vi.fn(() => ({
    context: { role: 'member', tenantSlugs: ['acme'], source: 'member', principal: 'member:carol' },
  })),
  conciergeErrorResponse: vi.fn(
    (error: unknown, status: number) =>
      new Response(JSON.stringify({ ok: false, error: String(error) }), { status })
  ),
}));
vi.mock('../../../../../lib/front-desk-member', () => ({
  conciergeDecisionDenied: mocks.decisionDenied,
}));
vi.mock('../../../../../lib/passkey-server', async () => {
  const actual = await vi.importActual<typeof import('../../../../../lib/passkey-server')>(
    '../../../../../lib/passkey-server'
  );
  return {
    ...actual,
    conciergePasskeyMember: mocks.member,
    conciergeRelyingParty: mocks.rp,
    passkeyRateLimited: mocks.rateLimited,
  };
});
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/governance/approval-store', () => ({
  loadApprovalRequest: mocks.loadApprovalRequest,
  decideApprovalRequest: mocks.decideApprovalRequest,
}));
vi.mock('@agent/core/authn/webauthn-verifier', () => ({
  createApprovalPasskeyOptions: mocks.createApprovalPasskeyOptions,
  verifyApprovalPasskeyAssertion: mocks.verifyApprovalPasskeyAssertion,
}));

import { POST } from './route.js';

function request(body: unknown): NextRequest {
  return {
    url: 'https://concierge.example/api/approvals/req-1/passkey',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}
const params = { params: Promise.resolve({ id: 'req-1' }) };
const rp = { rpId: 'concierge.example', origin: 'https://concierge.example', rpName: 'Kyberion' };

describe('concierge approval passkey route (HA-07)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.loadApprovalRequest.mockReturnValue({
      id: 'req-1',
      requestedByContext: { tenant_slug: 'acme' },
    });
    mocks.decisionDenied.mockReturnValue(null);
    mocks.member.mockReturnValue({
      memberId: 'carol',
      displayName: 'Carol',
      decidedBy: 'user:carol',
      role: 'owner',
    });
    mocks.rp.mockReturnValue(rp);
    mocks.rateLimited.mockReturnValue(null);
    mocks.decideApprovalRequest.mockImplementation((_role: string, params: object) => ({
      status: 'approved',
      ...params,
    }));
  });

  it('issues a challenge for the server-resolved member and tenant', async () => {
    mocks.createApprovalPasskeyOptions.mockResolvedValue({
      challengeId: 'ch-1',
      options: { challenge: 'abc' },
    });
    const response = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      challenge_id: 'ch-1',
      options: { challenge: 'abc' },
    });
    expect(mocks.decisionDenied).toHaveBeenCalledWith(expect.anything(), 'acme');
    expect(mocks.createApprovalPasskeyOptions).toHaveBeenCalledWith(
      'sovereign_concierge',
      expect.objectContaining({
        memberId: 'carol',
        decision: 'approved',
        presentedDigest: 'shown-digest',
        rp,
      })
    );
  });

  it('requires the digest the card showed and refuses a stale one', async () => {
    const missing = await POST(request({ action: 'options', decision: 'approved' }), params);
    expect(missing.status).toBe(400);
    expect(mocks.createApprovalPasskeyOptions).not.toHaveBeenCalled();

    mocks.createApprovalPasskeyOptions.mockRejectedValue(
      new Error(
        '[POLICY_VIOLATION] passkey approval refused — request req-1 changed since it was shown to the decider'
      )
    );
    const stale = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'old-digest' }),
      params
    );
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { error: string }).error).toMatch(
      /changed since it was shown/u
    );
  });

  it('takes the decision tenant from the request scope', async () => {
    mocks.loadApprovalRequest.mockReturnValue({ id: 'req-1', scope: { tenant_slug: 'globex' } });
    mocks.createApprovalPasskeyOptions.mockResolvedValue({ challengeId: 'ch-1', options: {} });
    await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(mocks.decisionDenied).toHaveBeenCalledWith(expect.anything(), 'globex');
  });

  it('records a passkey decision only from the verified proof', async () => {
    mocks.verifyApprovalPasskeyAssertion.mockResolvedValue({
      challengeId: 'ch-1',
      presentedDigest: 'digest-from-challenge',
      credentialId: 'cred-1',
    });
    const response = await POST(
      request({
        action: 'verify',
        decision: 'approved',
        challengeId: 'ch-1',
        response: { id: 'cred-1' },
      }),
      params
    );
    expect(response.status).toBe(200);
    expect(mocks.verifyApprovalPasskeyAssertion).toHaveBeenCalledWith(
      'sovereign_concierge',
      expect.objectContaining({ challengeId: 'ch-1', requestId: 'req-1', memberId: 'carol' })
    );
    expect(mocks.decideApprovalRequest).toHaveBeenCalledWith(
      'sovereign_concierge',
      expect.objectContaining({
        authMethod: 'passkey',
        decidedBy: 'user:carol',
        presentedDigest: 'digest-from-challenge',
        passkeyChallengeId: 'ch-1',
      })
    );
  });

  it('records nothing when the assertion fails verification', async () => {
    mocks.verifyApprovalPasskeyAssertion.mockRejectedValue(
      new Error('[POLICY_VIOLATION] passkey verification failed — signature did not verify')
    );
    const response = await POST(
      request({
        action: 'verify',
        decision: 'approved',
        challengeId: 'ch-1',
        response: { id: 'cred-1' },
      }),
      params
    );
    expect(response.status).toBe(403);
    expect(mocks.decideApprovalRequest).not.toHaveBeenCalled();
  });

  it('rejects client-supplied identity fields', async () => {
    const response = await POST(
      request({ action: 'options', decision: 'approved', decidedBy: 'user:mallory' }),
      params
    );
    expect(response.status).toBe(400);
    expect(mocks.createApprovalPasskeyOptions).not.toHaveBeenCalled();
  });

  it('refuses a viewer that resolves to no member', async () => {
    mocks.member.mockReturnValue(null);
    const response = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(response.status).toBe(403);
  });

  it('refuses when no public origin is configured', async () => {
    mocks.rp.mockReturnValue(null);
    const response = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(response.status).toBe(503);
  });

  it('applies the passkey rate limit', async () => {
    mocks.rateLimited.mockReturnValue(new Response('{}', { status: 429 }));
    const response = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(response.status).toBe(429);
    expect(mocks.loadApprovalRequest).not.toHaveBeenCalled();
  });

  it('honours the member decision gate', async () => {
    mocks.decisionDenied.mockReturnValue(new Response('{}', { status: 403 }));
    const response = await POST(
      request({ action: 'options', decision: 'approved', presentedDigest: 'shown-digest' }),
      params
    );
    expect(response.status).toBe(403);
    expect(mocks.createApprovalPasskeyOptions).not.toHaveBeenCalled();
  });
});
