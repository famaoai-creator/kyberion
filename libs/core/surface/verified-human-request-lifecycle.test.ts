/** Actual request lifecycle/store integration; only external effects use synthetic seams. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from '../organization/member-registry.js';
import type { FrontDeskExecutionMapping } from './front-desk-execution-contract.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  profiles: {} as Record<string, MemberProfile>,
  mappings: [] as FrontDeskExecutionMapping[],
  writes: 0,
  locks: 0,
  run: vi.fn(),
}));
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  listMemberIdsStrict: () => Object.keys(state.profiles).sort(),
  readMemberProfile: (id: string) => structuredClone(state.profiles[id] ?? null),
}));
vi.mock('../lock-utils.js', () => ({
  withLockSync: (_key: string, fn: () => unknown) => {
    state.locks++;
    return fn();
  },
}));
vi.mock('../workforce/artifact-store.js', () => ({
  readGovernedArtifactJson: (path: string) => structuredClone(state.files.get(path) ?? null),
  writeGovernedArtifactJson: (_role: string, path: string, value: unknown) => {
    state.writes++;
    state.files.set(path, structuredClone(value));
  },
}));
vi.mock('./channel-surface.js', () => ({ runSurfaceMessageConversation: state.run }));
vi.mock('./front-desk-execution-contract.js', async (original) => ({
  ...(await original<typeof import('./front-desk-execution-contract.js')>()),
  loadFrontDeskExecutionPolicy: () => ({ version: 1, mappings: structuredClone(state.mappings) }),
}));

import { runFrontDeskRequest } from './front-desk-request-service.js';
import { readFrontDeskRequest } from './front-desk-request-result.js';
import {
  completeConversationTurn,
  conversationRef,
  reserveConversationTurn,
} from './front-desk-conversation-store.js';
import {
  FRONT_DESK_RECEIPT_COMMAND,
  FRONT_DESK_RECEIPT_PIPELINE,
  FRONT_DESK_RECEIPT_VERSION,
  frontDeskExecutionViewerFingerprint,
  frontDeskExecutionViewerMatches,
} from './front-desk-execution-contract.js';
import {
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
  resolveVerifiedBrowserHumanRequestIdentity,
  resolveVerifiedHumanRequestIdentity,
  type HumanRequestNarrowing,
  type HumanRequestServerPolicy,
  type VerifiedHumanClaims,
} from './verified-human-request-identity.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const ID = '11111111-1111-4111-8111-111111111111';
const identity = { issuer: 'https://fixture-issuer.example', subject: 'alice-subject' };
const alias = { issuer: 'https://fixture-browser.example', subject: 'alice-browser-subject' };
const bobIdentity = { issuer: identity.issuer, subject: 'bob-subject' };
const request = () => ({ text: 'Hello', requestId: ID, requestCreatedAt: NOW });
const policy = (): HumanRequestServerPolicy => ({
  authorityNamespace: 'lifecycle-fixture:v1',
  tenantSlugs: ['alpha', 'beta'],
  organizationIds: ['org-a', 'org-b'],
  projectIds: ['project-a', 'project-b'],
  tierAccess: ['public', 'confidential'],
});
const narrowing = (): HumanRequestNarrowing => ({
  tenant: 'alpha',
  organizationId: 'org-a',
  projectId: 'project-a',
  tier: 'public',
});
function member(id: string, external: VerifiedHumanClaims[]): MemberProfile {
  return {
    member_id: id,
    display_name: id,
    status: 'active',
    memberships: [
      { tenant_slug: 'alpha', role: 'owner' },
      { tenant_slug: 'beta', role: 'operator' },
    ],
    external_identities: external,
    access_registrations: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}
function resolve(
  surface: 'mcp' | 'web',
  options: {
    policy?: HumanRequestServerPolicy;
    narrowing?: HumanRequestNarrowing;
    identity?: VerifiedHumanClaims;
    oauthScopes?: string[];
  } = {}
) {
  const verified = options.identity ?? (surface === 'web' ? alias : identity);
  const input = {
    policy: options.policy ?? policy(),
    narrowing: options.narrowing ?? narrowing(),
    oauthScopes: options.oauthScopes ?? [HUMAN_REQUEST_READ_SCOPE, HUMAN_REQUEST_RECEIVE_SCOPE],
  };
  return surface === 'mcp'
    ? resolveVerifiedHumanRequestIdentity({ ...input, identity: verified, transport: 'mcp-oauth' })
    : resolveVerifiedBrowserHumanRequestIdentity({
        ...input,
        enabled: true,
        now: NOW,
        proof: {
          ...verified,
          provider: 'browser-session',
          source: 'oidc',
          expiresAt: '2026-10-10T13:00:00.000Z',
        },
      });
}
function legacyViewer(): SurfaceViewerScope {
  const { canonicalHuman: _canonical, ...legacy } = resolve('mcp').viewer;
  return legacy;
}
function mapping(viewer: SurfaceViewerScope): FrontDeskExecutionMapping {
  return {
    id: 'synthetic-diagnostic',
    viewer,
    dotId: 'synthetic-dot',
    exactCommand: FRONT_DESK_RECEIPT_COMMAND,
    pipeline: { path: FRONT_DESK_RECEIPT_PIPELINE, version: FRONT_DESK_RECEIPT_VERSION },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.files.clear();
  state.profiles = { alice: member('alice', [identity, alias]), bob: member('bob', [bobIdentity]) };
  state.mappings = [];
  state.writes = 0;
  state.locks = 0;
  state.run.mockReset();
  state.run.mockResolvedValue({ text: 'Synthetic conversation answer.' });
});
afterEach(() => vi.useRealTimers());

describe('shared verified-human request lifecycle', () => {
  it.each(['mcp', 'web'] as const)(
    'reserves once from %s, shares pending state, and replays completed text inertly across entries',
    async (firstSurface) => {
      const secondSurface = firstSurface === 'mcp' ? 'web' : 'mcp';
      const firstViewer = resolve(firstSurface).viewer;
      const secondViewer = resolve(secondSurface).viewer;
      expect(conversationRef(firstViewer)).toEqual(conversationRef(secondViewer));
      let entered!: () => void;
      let release!: (value: unknown) => void;
      const runtimeEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const runtimeReply = new Promise((resolve) => {
        release = resolve;
      });
      state.run.mockImplementationOnce(() => {
        entered();
        return runtimeReply;
      });

      const running = runFrontDeskRequest(firstViewer, request());
      await runtimeEntered;
      expect(state.run).toHaveBeenCalledTimes(1);
      const pendingEffects = { writes: state.writes, locks: state.locks };
      expect(readFrontDeskRequest(secondViewer, ID)).toMatchObject({
        requestId: ID,
        replyStatus: 'pending',
      });
      expect({ writes: state.writes, locks: state.locks }).toEqual(pendingEffects);
      expect(await runFrontDeskRequest(secondViewer, request())).toEqual({
        kind: 'pending',
        requestId: ID,
      });
      expect(state.writes).toBe(pendingEffects.writes);
      expect(state.run).toHaveBeenCalledTimes(1);
      release({
        text: 'Review this synthetic plan.',
        missionProposals: [{ summary: 'Synthetic proposal' }],
      });
      expect(await running).toMatchObject({
        kind: 'replied',
        requestId: ID,
        historySaved: true,
        payload: { shape: 'execution_preview', nextActions: expect.any(Array) },
      });
      const settledEffects = { writes: state.writes, locks: state.locks };
      const readOnly = resolve(secondSurface, { oauthScopes: [HUMAN_REQUEST_READ_SCOPE] });
      expect(readFrontDeskRequest(readOnly.viewer, ID)).toMatchObject({
        replyStatus: 'answered',
        reply: 'Review this synthetic plan.',
      });
      expect({ writes: state.writes, locks: state.locks }).toEqual(settledEffects);
      const replay = await runFrontDeskRequest(resolve(secondSurface).viewer, request());
      expect(replay).toEqual({
        kind: 'replayed',
        requestId: ID,
        reply: 'Review this synthetic plan.',
      });
      expect(replay).not.toHaveProperty('payload');
      expect(replay).not.toHaveProperty('nextActions');
      expect(state.run).toHaveBeenCalledTimes(1);
      expect(state.writes).toBe(settledEffects.writes);
      expect(state.files.size).toBe(1);
      expect(state.run).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'user:alice',
          correlationId: ID,
          messageId: ID,
          conversationKey: conversationRef(firstViewer).key,
          scope: expect.objectContaining({
            tenant_slug: 'alpha',
            organization_id: 'org-a',
            project_id: 'project-a',
          }),
        })
      );
    }
  );

  it.each(['mcp', 'web'] as const)(
    'keeps uncertain execution nonretryable when crossing from %s',
    async (firstSurface) => {
      const secondSurface = firstSurface === 'mcp' ? 'web' : 'mcp';
      state.run.mockRejectedValueOnce(new Error('Synthetic interruption after possible execution'));
      expect(await runFrontDeskRequest(resolve(firstSurface).viewer, request())).toEqual({
        kind: 'uncertain',
        requestId: ID,
        existing: false,
      });
      const viewer = resolve(secondSurface).viewer;
      expect(readFrontDeskRequest(viewer, ID)).toMatchObject({ replyStatus: 'uncertain' });
      const writes = state.writes;
      expect(await runFrontDeskRequest(viewer, request())).toEqual({
        kind: 'uncertain',
        requestId: ID,
        existing: true,
      });
      expect(await runFrontDeskRequest(viewer, { ...request(), text: 'Changed request' })).toEqual({
        kind: 'rejected',
        stage: 'reservation',
        reason: 'request_conflict',
      });
      expect(state.run).toHaveBeenCalledTimes(1);
      expect(state.writes).toBe(writes);
    }
  );

  it('isolates other members, namespaces, every effective restriction, and current membership downgrades', async () => {
    const original = resolve('mcp').viewer;
    await runFrontDeskRequest(original, request());
    const otherViewers = [
      resolve('web', { identity: bobIdentity }).viewer,
      resolve('web', { policy: { ...policy(), authorityNamespace: 'another-deployment' } }).viewer,
      resolve('web', { narrowing: { ...narrowing(), tenant: 'beta' } }).viewer,
      resolve('web', { narrowing: { ...narrowing(), organizationId: 'org-b' } }).viewer,
      resolve('web', { narrowing: { ...narrowing(), projectId: 'project-b' } }).viewer,
      resolve('web', { narrowing: { ...narrowing(), tier: 'confidential' } }).viewer,
    ];
    state.profiles.alice.memberships[0].role = 'viewer';
    const downgraded = resolve('web');
    expect(downgraded.permissions).toEqual(['surface.headless.read']);
    otherViewers.push(downgraded.viewer);
    const before = { writes: state.writes, locks: state.locks };
    for (const viewer of otherViewers) {
      expect(conversationRef(viewer).key).not.toBe(conversationRef(original).key);
      expect(readFrontDeskRequest(viewer, ID)).toBeUndefined();
    }
    expect({ writes: state.writes, locks: state.locks }).toEqual(before);
    expect(state.run).toHaveBeenCalledTimes(1);
    expect(
      await runFrontDeskRequest(otherViewers[0], {
        ...request(),
        sessionId: conversationRef(original).sessionId,
      })
    ).toEqual({ kind: 'rejected', stage: 'session', reason: 'scope_changed' });
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it('never treats an identical request id as cross-member access', async () => {
    const alice = resolve('web').viewer;
    const bob = resolve('mcp', { identity: bobIdentity }).viewer;
    state.run
      .mockResolvedValueOnce({ text: 'Alice reply.' })
      .mockResolvedValueOnce({ text: 'Bob reply.' });
    await runFrontDeskRequest(alice, request());
    expect(readFrontDeskRequest(bob, ID)).toBeUndefined();
    await runFrontDeskRequest(bob, request());
    expect(readFrontDeskRequest(alice, ID)?.reply).toBe('Alice reply.');
    expect(readFrontDeskRequest(bob, ID)?.reply).toBe('Bob reply.');
    expect(state.run).toHaveBeenCalledTimes(2);
    expect(state.files.size).toBe(2);
  });

  it('pins the canonical marker through asynchronous execution', async () => {
    const viewer = structuredClone(resolve('web').viewer);
    const expected = conversationRef(viewer);
    const running = runFrontDeskRequest(viewer, request());
    viewer.canonicalHuman.authorityNamespace = 'mutated-after-admission';
    viewer.canonicalHuman.membershipFingerprint = 'f'.repeat(64);
    expect(await running).toMatchObject({ kind: 'replied', historySaved: true });
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: expected.key })
    );
    expect(readFrontDeskRequest(resolve('mcp').viewer, ID)?.reply).toBe(
      'Synthetic conversation answer.'
    );
    expect(readFrontDeskRequest(viewer, ID)).toBeUndefined();
    expect(state.files.size).toBe(1);
  });
});

describe('legacy and diagnostic boundaries', () => {
  it('preserves exact pre-canonical legacy hashes and never automatically migrates its history', () => {
    const legacy = legacyViewer();
    // Literal hashes computed from the baseline bccc2ebd serialization contract.
    expect(conversationRef(legacy).key).toBe(
      'daf153b9239e7eaad215d70450257497d561ef347190b6b4887635d4d6b52195'
    );
    expect(frontDeskExecutionViewerFingerprint(legacy)).toBe(
      'a219ac16dc3fdbeb63af20c131d117acac95567a61f3333e9c88383551b024e0'
    );
    reserveConversationTurn(legacy, 'Hello', ID, NOW);
    completeConversationTurn(legacy, ID, 'Legacy reply.');
    expect(readFrontDeskRequest(legacy, ID)?.reply).toBe('Legacy reply.');
    for (const surface of ['mcp', 'web'] as const) {
      const viewer = resolve(surface).viewer;
      expect(conversationRef(viewer).key).not.toBe(conversationRef(legacy).key);
      expect(frontDeskExecutionViewerFingerprint(viewer)).not.toBe(
        frontDeskExecutionViewerFingerprint(legacy)
      );
      expect(readFrontDeskRequest(viewer, ID)).toBeUndefined();
    }
    expect(state.files.size).toBe(1);
  });

  it('fails closed on malformed canonical markers before read, reservation, or runtime', async () => {
    const viewer = resolve('mcp').viewer;
    await runFrontDeskRequest(viewer, request());
    const before = { writes: state.writes, locks: state.locks };
    for (const canonicalHuman of [
      undefined,
      null,
      {},
      { ...viewer.canonicalHuman, memberId: 'bob' },
      { ...viewer.canonicalHuman, membershipFingerprint: 'invalid' },
    ]) {
      const malformed = { ...viewer, canonicalHuman } as SurfaceViewerScope;
      expect(() => conversationRef(malformed)).toThrow();
      expect(() => frontDeskExecutionViewerFingerprint(malformed)).toThrow();
      expect(() => readFrontDeskRequest(malformed, ID)).toThrow();
      expect(await runFrontDeskRequest(malformed, request())).toEqual({
        kind: 'rejected',
        stage: 'scope',
        reason: 'identity_required',
      });
    }
    expect({ writes: state.writes, locks: state.locks }).toEqual(before);
    expect(state.run).toHaveBeenCalledTimes(1);
  });

  it('cannot acquire a diagnostic execution mapping even with matching principal and scope', async () => {
    const viewer = resolve('mcp').viewer;
    const legacy = legacyViewer();
    const legacyMapping = mapping(legacy);
    const canonicalMapping = mapping(viewer);
    expect(frontDeskExecutionViewerMatches(legacy, legacyMapping)).toBe(true);
    expect(frontDeskExecutionViewerMatches(viewer, legacyMapping)).toBe(false);
    expect(frontDeskExecutionViewerMatches(viewer, canonicalMapping)).toBe(false);
    state.mappings = [legacyMapping, canonicalMapping];
    await runFrontDeskRequest(viewer, { ...request(), text: FRONT_DESK_RECEIPT_COMMAND });
    const transcript = state.files.get(conversationRef(viewer).path) as {
      executionRequests?: unknown[];
    };
    expect(transcript.executionRequests ?? []).toEqual([]);
    const snapshot = readFrontDeskRequest(resolve('web').viewer, ID);
    expect(
      snapshot?.work.every(
        (work) => work.executionStatus === undefined && work.workItemId === undefined
      )
    ).toBe(true);
    expect(() =>
      reserveConversationTurn(viewer, FRONT_DESK_RECEIPT_COMMAND, ID, NOW, undefined, undefined, {
        requireDiagnosticAdmission: true,
      })
    ).toThrow('diagnostic_admission_required');
    expect(state.run).toHaveBeenCalledTimes(1);
  });
});
