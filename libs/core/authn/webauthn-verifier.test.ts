import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import {
  approvalStoreRoots,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  createApprovalRequest,
  decideApprovalRequest,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import {
  consumeApprovalPasskeyChallenge,
  encodeApprovalPasskeyChallenge,
} from '../governance/approval-passkey-challenge.js';
import {
  createApprovalPasskeyOptions,
  createPasskeyRegistrationOptions,
  createPasskeyStepUpOptions,
  resolveWebAuthnRelyingParty,
  revokeMemberPasskey,
  verifyApprovalPasskeyAssertion,
  verifyPasskeyRegistration,
  verifyPasskeyStepUp,
  type WebAuthnRelyingParty,
} from './webauthn-verifier.js';
import { issueApprovalPasskeyChallenge } from '../governance/approval-passkey-challenge.js';
import {
  findPasskeyCredential,
  listPasskeyCredentials,
  passkeyCredentialPath,
  revokePasskeyCredential,
} from './passkey-credential-store.js';
import { createTestAuthenticator, type TestAuthenticator } from './__tests__/webauthn-fixtures.js';

const CHANNEL = `passkey-${process.pid}`;
const RP: WebAuthnRelyingParty = {
  rpId: 'localhost',
  origin: 'http://localhost:3050',
  rpName: 'Kyberion',
};
const ROLE = 'mission_controller' as const;

let fixtureRoot = '';
let store: { rootDir: string };
let savedPersona: string | undefined;
let savedRole: string | undefined;

beforeAll(() => {
  fixtureRoot = path.join(
    pathResolver.rootDir(),
    'active',
    'shared',
    'tmp',
    `passkey-${randomUUID()}`
  );
  store = { rootDir: fixtureRoot };
  savedPersona = process.env.KYBERION_PERSONA;
  savedRole = process.env.MISSION_ROLE;
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  process.env.MISSION_ROLE = 'mission_controller';
});

afterAll(() => {
  if (safeExistsSync(fixtureRoot)) safeRmSync(fixtureRoot, { recursive: true, force: true });
  if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = savedPersona;
  if (savedRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = savedRole;
});

afterEach(() => {
  vi.unstubAllEnvs();
  withExecutionContext(ROLE, () => {
    for (const root of Object.values(approvalStoreRoots())) {
      const dir = pathResolver.rootResolve(`${root}/${CHANNEL}`);
      if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A usable passkey: enrolled long enough ago that its cooldown is over. */
async function registered(memberId: string): Promise<TestAuthenticator> {
  const authenticator = createTestAuthenticator();
  const enrolledAt = new Date(Date.now() - 2 * 3_600_000);
  const options = await createPasskeyRegistrationOptions({
    memberId,
    displayName: memberId,
    rp: RP,
    store,
    now: enrolledAt,
  });
  await verifyPasskeyRegistration({
    memberId,
    response: authenticator.register({
      challenge: options.challenge,
      origin: RP.origin,
      rpId: RP.rpId,
    }),
    rp: RP,
    label: 'Laptop',
    cooldownHours: 1,
    store,
    now: enrolledAt,
  });
  return authenticator;
}

function a3Request(correlationId: string): ApprovalRequestRecord {
  return createApprovalRequest(ROLE, {
    channel: CHANNEL,
    threadTs: '1',
    correlationId,
    requestedBy: 'agent:planner',
    draft: { title: 'Trust project acme/site', summary: 'HA-07 fixture' },
    accountability: {
      finalDecision: 'human_only',
      min_assurance: 'A3',
      payloadHash: computeApprovalPayloadHash({ trust: 'acme/site' }),
      effectBinding: 'project-trust:acme/site',
    },
  });
}

async function verifiedFor(
  memberId: string,
  authenticator: TestAuthenticator,
  record: ApprovalRequestRecord,
  decision: 'approved' | 'rejected' = 'approved',
  counter = 1
) {
  const { challengeId, options } = await createApprovalPasskeyOptions(ROLE, {
    record,
    presentedDigest: computeApprovalPresentedDigest(record),
    storageChannel: CHANNEL,
    decision,
    memberId,
    rp: RP,
    store,
  });
  return verifyApprovalPasskeyAssertion(ROLE, {
    challengeId,
    storageChannel: CHANNEL,
    requestId: record.id,
    decision,
    memberId,
    rp: RP,
    store,
    response: authenticator.assert({
      challenge: options.challenge,
      origin: RP.origin,
      rpId: RP.rpId,
      counter,
    }),
  });
}

function passkeyDecision(
  record: ApprovalRequestRecord,
  memberId: string,
  proof: { challengeId: string; presentedDigest: string },
  decision: 'approved' | 'rejected' = 'approved'
) {
  return decideApprovalRequest(ROLE, {
    channel: CHANNEL,
    requestId: record.id,
    decision,
    decidedBy: `user:${memberId}`,
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'passkey',
    presentedDigest: proof.presentedDigest,
    passkeyChallengeId: proof.challengeId,
  });
}

describe('resolveWebAuthnRelyingParty', () => {
  it('uses the declared public origin, per surface first', () => {
    const env = {
      KYBERION_OIDC_PUBLIC_BASE_URL: 'https://kyberion.example.com',
      KYBERION_OIDC_PUBLIC_BASE_URLS: 'concierge=https://desk.example.com',
    };
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'concierge',
        requestOrigin: 'https://evil.example.net',
        loopback: false,
        env,
      })
    ).toEqual({ rpId: 'desk.example.com', origin: 'https://desk.example.com', rpName: 'Kyberion' });
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'chronos',
        requestOrigin: 'x',
        loopback: false,
        env,
      })?.rpId
    ).toBe('kyberion.example.com');
  });

  it('falls back to the request origin only for loopback, never for a remote Host header', () => {
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'concierge',
        requestOrigin: 'http://localhost:3050',
        loopback: true,
        env: {},
      })
    ).toEqual({ rpId: 'localhost', origin: 'http://localhost:3050', rpName: 'Kyberion' });
    // A remote peer sending `Host: localhost` is not loopback.
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'concierge',
        requestOrigin: 'http://localhost:3050',
        loopback: false,
        env: {},
      })
    ).toBeNull();
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'concierge',
        requestOrigin: 'https://attacker.example.net',
        loopback: false,
        env: {},
      })
    ).toBeNull();
    expect(
      resolveWebAuthnRelyingParty({
        surfaceId: 'concierge',
        requestOrigin: 'x',
        loopback: false,
        env: { KYBERION_OIDC_PUBLIC_BASE_URL: 'http://desk.example.com' },
      })
    ).toBeNull();
  });
});

describe('passkey registration and credential store', () => {
  it('registers, lists without key material, and revokes', async () => {
    const authenticator = await registered('alice');
    expect(passkeyCredentialPath('alice', store)).toContain(
      path.join('knowledge', 'personal', 'members', 'alice', 'passkeys.json')
    );
    const listed = listPasskeyCredentials('alice', store);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      credential_id: authenticator.credentialId,
      label: 'Laptop',
      transports: ['internal'],
    });
    expect(listed[0]).not.toHaveProperty('public_key');
    const stored = findPasskeyCredential('alice', authenticator.credentialId, store);
    expect(stored?.counter).toBe(0);
    const raw = String(safeReadFile(passkeyCredentialPath('alice', store), { encoding: 'utf8' }));
    expect(raw).not.toContain('"alice"\n');
    expect(revokePasskeyCredential('alice', authenticator.credentialId, store)).toBe(true);
    expect(revokePasskeyCredential('alice', authenticator.credentialId, store)).toBe(false);
    expect(listPasskeyCredentials('alice', store)).toEqual([]);
  });

  it('accepts a registration challenge once and rejects a wrong origin', async () => {
    const authenticator = createTestAuthenticator();
    const options = await createPasskeyRegistrationOptions({
      memberId: 'carol',
      displayName: 'Carol',
      rp: RP,
      store,
    });
    const response = authenticator.register({
      challenge: options.challenge,
      origin: 'https://evil.example.net',
      rpId: RP.rpId,
    });
    await expect(
      verifyPasskeyRegistration({ memberId: 'carol', response, rp: RP, store })
    ).rejects.toThrow(/registration response did not verify/u);
    // The challenge was taken by the failed attempt.
    const good = authenticator.register({
      challenge: options.challenge,
      origin: RP.origin,
      rpId: RP.rpId,
    });
    await expect(
      verifyPasskeyRegistration({ memberId: 'carol', response: good, rp: RP, store })
    ).rejects.toThrow(/no passkey registration is in progress/u);
  });

  it('refuses an expired registration challenge', async () => {
    const authenticator = createTestAuthenticator();
    const issuedAt = new Date('2026-10-10T00:00:00.000Z');
    const options = await createPasskeyRegistrationOptions({
      memberId: 'erin',
      displayName: 'Erin',
      rp: RP,
      store,
      now: issuedAt,
    });
    await expect(
      verifyPasskeyRegistration({
        memberId: 'erin',
        response: authenticator.register({
          challenge: options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
        }),
        rp: RP,
        store,
        now: new Date(issuedAt.getTime() + 301_000),
      })
    ).rejects.toThrow(/registration expired/u);
  });
});

describe('approval passkey assertion (HA-07)', () => {
  it('binds the challenge to the presented digest, request, decision and expiry', async () => {
    const authenticator = await registered('dana');
    const record = a3Request('binding');
    const { challengeId, options } = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'dana',
      rp: RP,
      store,
    });
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials?.map((entry) => entry.id)).toEqual([
      authenticator.credentialId,
    ]);
    const proof = await verifyApprovalPasskeyAssertion(ROLE, {
      challengeId,
      storageChannel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      memberId: 'dana',
      rp: RP,
      store,
      response: authenticator.assert({
        challenge: options.challenge,
        origin: RP.origin,
        rpId: RP.rpId,
        counter: 1,
      }),
    });
    expect(proof.presentedDigest).toBe(computeApprovalPresentedDigest(record));
    expect(findPasskeyCredential('dana', authenticator.credentialId, store)?.counter).toBe(1);

    const decided = passkeyDecision(record, 'dana', proof);
    expect(decided.status).toBe('approved');
    expect(decided.decidedAuthMethod).toBe('passkey');
    expect(decided.assuranceShortfall).toBeUndefined();
  });

  it('rejects an assertion over a challenge for a different digest', async () => {
    const authenticator = await registered('frank');
    const record = a3Request('wrong-digest');
    const { challengeId } = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'frank',
      rp: RP,
      store,
    });
    const forged = encodeApprovalPasskeyChallenge({
      request_id: record.id,
      decision: 'approved',
      presented_digest: '0'.repeat(64),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      nonce: 'forged',
    });
    await expect(
      verifyApprovalPasskeyAssertion(ROLE, {
        challengeId,
        storageChannel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        memberId: 'frank',
        rp: RP,
        store,
        response: authenticator.assert({
          challenge: forged,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: 1,
        }),
      })
    ).rejects.toThrow(/assertion did not verify/u);
  });

  it('refuses the decision when the request changed after the passkey signed it', async () => {
    const authenticator = await registered('gina');
    const record = a3Request('changed');
    const proof = await verifiedFor('gina', authenticator, record);
    expect(() =>
      passkeyDecision(record, 'gina', { ...proof, presentedDigest: '1'.repeat(64) })
    ).toThrow(/changed since it was shown/u);
  });

  it('rejects an expired challenge', async () => {
    const authenticator = await registered('hank');
    const record = a3Request('expired');
    const issuedAt = new Date();
    const { challengeId, options } = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'hank',
      rp: RP,
      store,
      now: issuedAt,
    });
    await expect(
      verifyApprovalPasskeyAssertion(ROLE, {
        challengeId,
        storageChannel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        memberId: 'hank',
        rp: RP,
        store,
        now: new Date(issuedAt.getTime() + 121_000),
        response: authenticator.assert({
          challenge: options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: 1,
        }),
      })
    ).rejects.toThrow(/challenge expired/u);
  });

  it('rejects a replayed assertion and a reused challenge', async () => {
    const authenticator = await registered('ivan');
    const record = a3Request('replay');
    const { challengeId, options } = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'ivan',
      rp: RP,
      store,
    });
    const response = authenticator.assert({
      challenge: options.challenge,
      origin: RP.origin,
      rpId: RP.rpId,
      counter: 1,
    });
    const input = {
      challengeId,
      storageChannel: CHANNEL,
      requestId: record.id,
      decision: 'approved' as const,
      memberId: 'ivan',
      rp: RP,
      store,
      response,
    };
    const proof = await verifyApprovalPasskeyAssertion(ROLE, input);
    await expect(verifyApprovalPasskeyAssertion(ROLE, input)).rejects.toThrow(/already used/u);
    passkeyDecision(record, 'ivan', proof);
    expect(() =>
      consumeApprovalPasskeyChallenge(ROLE, {
        storageChannel: CHANNEL,
        challengeId: proof.challengeId,
        requestId: record.id,
        decidedBy: 'user:ivan',
        decision: 'approved',
        presentedDigest: proof.presentedDigest,
      })
    ).toThrow(/already used/u);
    const second = a3Request('replay-second');
    expect(() =>
      passkeyDecision(second, 'ivan', {
        ...proof,
        presentedDigest: computeApprovalPresentedDigest(second),
      })
    ).toThrow(/another request/u);
  });

  it('rejects a signature counter that does not advance', async () => {
    const authenticator = await registered('judy');
    await verifiedFor('judy', authenticator, a3Request('counter-1'), 'approved', 5);
    await expect(
      verifiedFor('judy', authenticator, a3Request('counter-2'), 'approved', 5)
    ).rejects.toThrow(/counter/u);
    expect(findPasskeyCredential('judy', authenticator.credentialId, store)?.counter).toBe(5);
  });

  it("rejects another member's credential", async () => {
    await registered('kate');
    const mallory = await registered('mallory');
    const record = a3Request('other-member');
    const { challengeId, options } = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'kate',
      rp: RP,
      store,
    });
    await expect(
      verifyApprovalPasskeyAssertion(ROLE, {
        challengeId,
        storageChannel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        memberId: 'kate',
        rp: RP,
        store,
        response: mallory.assert({
          challenge: options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: 1,
        }),
      })
    ).rejects.toThrow(/not registered to the deciding member/u);
    // Nor can mallory verify kate's challenge as herself.
    const again = await createApprovalPasskeyOptions(ROLE, {
      record,
      presentedDigest: computeApprovalPresentedDigest(record),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'kate',
      rp: RP,
      store,
    });
    await expect(
      verifyApprovalPasskeyAssertion(ROLE, {
        challengeId: again.challengeId,
        storageChannel: CHANNEL,
        requestId: record.id,
        decision: 'approved',
        memberId: 'mallory',
        rp: RP,
        store,
        response: mallory.assert({
          challenge: again.options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: 2,
        }),
      })
    ).rejects.toThrow(/another member/u);
  });

  it('refuses a passkey proof recorded for another member or the other decision', async () => {
    const authenticator = await registered('liam');
    const record = a3Request('mismatch');
    const proof = await verifiedFor('liam', authenticator, record, 'rejected');
    expect(() => passkeyDecision(record, 'liam', proof, 'approved')).toThrow(/other decision/u);
    expect(() => passkeyDecision(record, 'kate', proof, 'rejected')).toThrow(/another member/u);
    expect(passkeyDecision(record, 'liam', proof, 'rejected').status).toBe('rejected');
  });

  it('never takes passkey on the caller’s word', () => {
    const record = a3Request('declared');
    const base = {
      channel: CHANNEL,
      requestId: record.id,
      decision: 'approved' as const,
      decidedBy: 'user:owner',
      decidedByType: 'human' as const,
      authenticated: true,
      presentedDigest: computeApprovalPresentedDigest(record),
    };
    expect(() => decideApprovalRequest(ROLE, { ...base, authMethod: 'passkey' })).toThrow(
      /needs its verified challenge/u
    );
    expect(() =>
      decideApprovalRequest(ROLE, {
        ...base,
        authMethod: 'surface_session',
        passkeyChallengeId: randomUUID(),
      })
    ).toThrow(/passkey challenge was sent with authMethod surface_session/u);
  });

  it('requires a registered passkey before issuing a challenge', async () => {
    const none = a3Request('none');
    await expect(
      createApprovalPasskeyOptions(ROLE, {
        record: none,
        presentedDigest: computeApprovalPresentedDigest(none),
        storageChannel: CHANNEL,
        decision: 'approved',
        memberId: 'nobody',
        rp: RP,
        store,
      })
    ).rejects.toThrow(/no registered passkey/u);
  });
});

describe('approval passkey options carry the displayed digest (M1)', () => {
  it('refuses a stale or missing digest', async () => {
    await registered('olga');
    const record = a3Request('stale-digest');
    await expect(
      createApprovalPasskeyOptions(ROLE, {
        record,
        presentedDigest: 'a'.repeat(64),
        storageChannel: CHANNEL,
        decision: 'approved',
        memberId: 'olga',
        rp: RP,
        store,
      })
    ).rejects.toThrow(/changed since it was shown/u);
    await expect(
      createApprovalPasskeyOptions(ROLE, {
        record,
        presentedDigest: '',
        storageChannel: CHANNEL,
        decision: 'approved',
        memberId: 'olga',
        rp: RP,
        store,
      })
    ).rejects.toThrow(/changed since it was shown/u);
  });

  it('issues for a later stage of a staged workflow that still owes a decision', () => {
    const base = a3Request('staged');
    const staged: ApprovalRequestRecord = {
      ...base,
      status: 'approved',
      workflow: {
        workflowId: 'wf-1',
        mode: 'staged',
        requiredRoles: ['owner', 'security'],
        currentStage: 'security',
        stages: [
          { stageId: 'owner', requiredRoles: ['owner'] },
          { stageId: 'security', requiredRoles: ['security'] },
        ],
        approvals: [
          { role: 'owner', status: 'approved' },
          { role: 'security', status: 'pending' },
        ],
      },
    };
    const challenge = issueApprovalPasskeyChallenge(ROLE, {
      record: staged,
      presentedDigest: computeApprovalPresentedDigest(staged),
      storageChannel: CHANNEL,
      decision: 'approved',
      memberId: 'olga',
    });
    expect(challenge.request_id).toBe(base.id);
    const settled = { ...staged, workflow: { ...staged.workflow!, approvals: [] } };
    expect(() =>
      issueApprovalPasskeyChallenge(ROLE, {
        record: settled,
        presentedDigest: computeApprovalPresentedDigest(settled),
        storageChannel: CHANNEL,
        decision: 'approved',
        memberId: 'olga',
      })
    ).toThrow(/no longer takes a decision/u);
  });
});

describe('passkey enrollment hardening (B1)', () => {
  async function enroll(
    memberId: string,
    authenticator: TestAuthenticator,
    options: { now?: Date; cooldownHours?: number; stepUpToken?: string; verifyToken?: string } = {}
  ) {
    const creation = await createPasskeyRegistrationOptions({
      memberId,
      displayName: memberId,
      rp: RP,
      store,
      now: options.now,
      stepUpToken: options.stepUpToken,
    });
    return verifyPasskeyRegistration({
      memberId,
      response: authenticator.register({
        challenge: creation.challenge,
        origin: RP.origin,
        rpId: RP.rpId,
      }),
      rp: RP,
      store,
      now: options.now,
      cooldownHours: options.cooldownHours,
      stepUpToken: 'verifyToken' in options ? options.verifyToken : options.stepUpToken,
    });
  }

  async function stepUp(
    memberId: string,
    authenticator: TestAuthenticator,
    purpose: 'enroll' | 'revoke',
    counter: number,
    target?: string
  ) {
    const options = await createPasskeyStepUpOptions({ memberId, purpose, target, rp: RP, store });
    return verifyPasskeyStepUp({
      memberId,
      rp: RP,
      store,
      response: authenticator.assert({
        challenge: options.challenge,
        origin: RP.origin,
        rpId: RP.rpId,
        counter,
      }),
    });
  }

  it('cools a first passkey down before it can settle an A3 decision, then allows it', async () => {
    const enrolledAt = new Date();
    const authenticator = createTestAuthenticator();
    const summary = await enroll('pete', authenticator, { now: enrolledAt, cooldownHours: 24 });
    const usableAfter = new Date(enrolledAt.getTime() + 24 * 3_600_000);
    expect(summary.usable_after).toBe(usableAfter.toISOString());
    const record = a3Request('cooldown');
    const request = (now: Date) =>
      createApprovalPasskeyOptions(ROLE, {
        record,
        presentedDigest: computeApprovalPresentedDigest(record),
        storageChannel: CHANNEL,
        decision: 'approved',
        memberId: 'pete',
        rp: RP,
        store,
        now,
      });
    await expect(request(enrolledAt)).rejects.toThrow(
      new RegExp(
        `enrollment cooldown and can approve A3 requests from ${usableAfter.toISOString()}`
      )
    );
    const later = new Date(usableAfter.getTime() + 1_000);
    const { challengeId, options } = await request(later);
    const proof = await verifyApprovalPasskeyAssertion(ROLE, {
      challengeId,
      storageChannel: CHANNEL,
      requestId: record.id,
      decision: 'approved',
      memberId: 'pete',
      rp: RP,
      store,
      now: later,
      response: authenticator.assert({
        challenge: options.challenge,
        origin: RP.origin,
        rpId: RP.rpId,
        counter: 1,
      }),
    });
    expect(passkeyDecision(record, 'pete', proof).decidedAuthMethod).toBe('passkey');
  });

  it('takes the cooldown from approval-policy.json by default and never goes below an hour', async () => {
    const summary = await enroll('quinn', createTestAuthenticator());
    expect(Date.parse(summary.usable_after!) - Date.parse(summary.created_at)).toBe(24 * 3_600_000);
    const clamped = await enroll('quincy', createTestAuthenticator(), { cooldownHours: 0 });
    expect(Date.parse(clamped.usable_after!) - Date.parse(clamped.created_at)).toBe(3_600_000);
  });

  it('requires a step-up from a usable passkey to enroll another, then needs no cooldown', async () => {
    const first = await registered('rosa');
    const second = createTestAuthenticator();
    await expect(enroll('rosa', second)).rejects.toThrow(
      /needs a confirmation with a usable passkey/u
    );
    // A step-up confirmed for revoke does not authorize an enrollment.
    const revoke = await stepUp('rosa', first, 'revoke', 1, first.credentialId);
    await expect(enroll('rosa', second, { stepUpToken: revoke.stepUpToken })).rejects.toThrow(
      /confirmed for another change/u
    );
    const confirmed = await stepUp('rosa', first, 'enroll', 2);
    expect(confirmed.stepUpToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const added = await enroll('rosa', second, { stepUpToken: confirmed.stepUpToken });
    expect(added.usable_after).toBeUndefined();
    expect(added.enrolled_with).toBe(first.credentialId);
    expect(listPasskeyCredentials('rosa', store)).toHaveLength(2);
    // The step-up and its token are single use.
    await expect(
      enroll('rosa', createTestAuthenticator(), { stepUpToken: confirmed.stepUpToken })
    ).rejects.toThrow(/needs a confirmation with a usable passkey/u);
    const raw = String(safeReadFile(passkeyCredentialPath('rosa', store), { encoding: 'utf8' }));
    expect(raw).not.toContain(confirmed.stepUpToken);
  });

  it('keeps a step-up to the session that performed it (N1)', async () => {
    const first = await registered('nina');
    // Session A confirms; session B (same member, no token) tries to spend it.
    const sessionA = await stepUp('nina', first, 'enroll', 1);
    await expect(
      createPasskeyRegistrationOptions({ memberId: 'nina', displayName: 'nina', rp: RP, store })
    ).rejects.toThrow(/step-up token is missing or belongs to another confirmation/u);
    await expect(
      createPasskeyRegistrationOptions({
        memberId: 'nina',
        displayName: 'nina',
        rp: RP,
        store,
        stepUpToken: 'b'.repeat(43),
      })
    ).rejects.toThrow(/step-up token is missing or belongs to another confirmation/u);
    // Session A starts the registration; session B cannot complete it.
    const creation = await createPasskeyRegistrationOptions({
      memberId: 'nina',
      displayName: 'nina',
      rp: RP,
      store,
      stepUpToken: sessionA.stepUpToken,
    });
    const attacker = createTestAuthenticator();
    await expect(
      verifyPasskeyRegistration({
        memberId: 'nina',
        response: attacker.register({
          challenge: creation.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
        }),
        rp: RP,
        store,
      })
    ).rejects.toThrow(/confirmed from another session/u);
    expect(listPasskeyCredentials('nina', store)).toHaveLength(1);
  });

  it('refuses a registration verify that presents another token', async () => {
    const first = await registered('olga');
    const confirmed = await stepUp('olga', first, 'enroll', 1);
    await expect(
      enroll('olga', createTestAuthenticator(), {
        stepUpToken: confirmed.stepUpToken,
        verifyToken: 'x'.repeat(43),
      })
    ).rejects.toThrow(/confirmed from another session/u);
  });

  it('refuses a replayed step-up assertion', async () => {
    const authenticator = await registered('sam');
    const options = await createPasskeyStepUpOptions({
      memberId: 'sam',
      purpose: 'enroll',
      rp: RP,
      store,
    });
    const response = authenticator.assert({
      challenge: options.challenge,
      origin: RP.origin,
      rpId: RP.rpId,
      counter: 1,
    });
    await verifyPasskeyStepUp({ memberId: 'sam', response, rp: RP, store });
    await expect(verifyPasskeyStepUp({ memberId: 'sam', response, rp: RP, store })).rejects.toThrow(
      /already used/u
    );
  });

  it('requires a step-up, with its token, to revoke while a usable passkey exists', async () => {
    const authenticator = await registered('tara');
    const id = authenticator.credentialId;
    expect(() => revokeMemberPasskey({ memberId: 'tara', credentialId: id, store })).toThrow(
      /needs a confirmation with a usable passkey \(revoke\)/u
    );
    const confirmed = await stepUp('tara', authenticator, 'revoke', 1, id);
    expect(() => revokeMemberPasskey({ memberId: 'tara', credentialId: id, store })).toThrow(
      /step-up token is missing/u
    );
    expect(
      revokeMemberPasskey({
        memberId: 'tara',
        credentialId: id,
        store,
        stepUpToken: confirmed.stepUpToken,
      })
    ).toEqual({ credentialId: id, steppedUpWith: id, wasCoolingDown: false });
    expect(
      revokeMemberPasskey({
        memberId: 'tara',
        credentialId: id,
        store,
        stepUpToken: confirmed.stepUpToken,
      })
    ).toBeNull();
  });

  it('a revoke step-up for one passkey cannot revoke another (N6)', async () => {
    const first = await registered('ursa');
    const confirmed = await stepUp('ursa', first, 'enroll', 1);
    const second = createTestAuthenticator();
    await enroll('ursa', second, { stepUpToken: confirmed.stepUpToken });
    const forSecond = await stepUp('ursa', first, 'revoke', 2, second.credentialId);
    expect(() =>
      revokeMemberPasskey({
        memberId: 'ursa',
        credentialId: first.credentialId,
        store,
        stepUpToken: forSecond.stepUpToken,
      })
    ).toThrow(/confirmed for another change/u);
    expect(listPasskeyCredentials('ursa', store)).toHaveLength(2);
    expect(
      revokeMemberPasskey({
        memberId: 'ursa',
        credentialId: second.credentialId,
        store,
        stepUpToken: forSecond.stepUpToken,
      })?.credentialId
    ).toBe(second.credentialId);
  });

  it('lets the member revoke a cooling-down passkey (e.g. one a stolen session added) without one', async () => {
    const authenticator = createTestAuthenticator();
    await enroll('uma', authenticator, { cooldownHours: 24 });
    expect(
      revokeMemberPasskey({ memberId: 'uma', credentialId: authenticator.credentialId, store })
    ).toEqual({ credentialId: authenticator.credentialId, wasCoolingDown: true });
  });

  it('refuses a step-up from a passkey still cooling down', async () => {
    await enroll('vera', createTestAuthenticator(), { cooldownHours: 24 });
    await expect(
      createPasskeyStepUpOptions({ memberId: 'vera', purpose: 'enroll', rp: RP, store })
    ).rejects.toThrow(/no usable passkey to confirm with/u);
  });
});
