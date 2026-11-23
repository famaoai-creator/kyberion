import { describe, expect, it } from 'vitest';
import {
  ShareGrantLiveSessionRegistry,
  ShareGrantLiveSessionValidationError,
} from './share-grant-live-sessions.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import { ShareGrantGraph } from './share-grant-graph.js';

const expiresAt = '2099-08-09T00:00:00.000Z';

describe('ShareGrantLiveSessionRegistry', () => {
  it('keeps registration and active reads aligned at expiry and after revocation', () => {
    const scenarios = [0, 1, 2].flatMap((elapsed) =>
      [false, true].flatMap((revoked) =>
        (['unchanged', 'restricted', 'suspended'] as const).map((change) => ({
          elapsed,
          revoked,
          change,
        }))
      )
    );
    type State =
      | { stage: 'initial' }
      | {
          stage: 'checked';
          allowed: boolean;
          visible: boolean;
          reopened: boolean;
        };
    const result = checkFiniteStateSafety<State>({
      initial: [{ stage: 'initial' }],
      key: JSON.stringify,
      next: (state) =>
        state.stage === 'initial'
          ? scenarios.map(({ elapsed, revoked, change }) => {
              const start = Date.parse('2026-08-09T00:00:00.000Z');
              let now = start;
              let restricted = false;
              let suspended = false;
              const registry = new ShareGrantLiveSessionRegistry({
                now: () => now,
                isLinkActive: (resourceRef, linkId): boolean =>
                  graph.isShareLinkActive(resourceRef, linkId),
              });
              const graph = new ShareGrantGraph({
                persist: false,
                now: () => now,
                hmacKey: 'session-model-test-key-123456789',
                authorizeActor: () => undefined,
                resolveTenant: () => ({ status: suspended ? 'suspended' : 'active' }),
                resolveProvenance: (missionId) => ({
                  missionId,
                  highestTier: restricted ? 'confidential' : 'public',
                  tenants: ['tenant-a'],
                  prohibitExternal: restricted,
                  observationIds: [],
                }),
                liveSessionEvictor: registry,
              });
              const actor = {
                principalId: 'principal:owner',
                authenticated: true,
                tenantSlugs: 'all',
              } as const;
              const resourceRef = 'artifact:model';
              graph.registerResource({
                resourceRef,
                tenantSlug: 'tenant-a',
                taint: 'public',
                provenanceMissionId: 'MSN-LIVE-SHARE',
                actor,
              });
              const link = graph.issueShareLink({
                resourceRef,
                actor,
                role: 'view',
                expiresAt: new Date(start + 1000).toISOString(),
              });
              const open = () =>
                graph.openShareLinkSession({
                  resourceRef,
                  token: link.token,
                  sessionId: 'model-session',
                  connectedAt: new Date(start).toISOString(),
                });
              expect(open()).not.toBeNull();
              now += elapsed * 1000;
              if (revoked) graph.revokeShareLink(link.linkId, actor);
              restricted = change === 'restricted';
              suspended = change === 'suspended';
              return {
                action: `elapsed=${elapsed}, revoked=${revoked}, change=${change}`,
                state: {
                  stage: 'checked',
                  allowed: elapsed === 0 && !revoked && change === 'unchanged',
                  visible: registry.listActive().length === 1,
                  reopened: open() !== null,
                },
              };
            })
          : [],
      invariants: {
        matchesCurrentLink: (state) =>
          state.stage === 'initial' ||
          (state.visible === state.allowed && state.reopened === state.allowed),
      },
    });
    expect(result).toMatchObject({ status: 'verified', transitions: 18 });
  });

  it('evicts only sessions belonging to the revoked link and resource', () => {
    const registry = new ShareGrantLiveSessionRegistry();
    registry.registerShareLinkSession({
      sessionId: 'session-a',
      linkId: 'link-a',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:00.000Z',
      expiresAt,
    });
    registry.registerShareLinkSession({
      sessionId: 'session-b',
      linkId: 'link-b',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:01.000Z',
      expiresAt,
    });
    registry.registerShareLinkSession({
      sessionId: 'session-c',
      linkId: 'link-a',
      resourceRef: 'artifact:two',
      connectedAt: '2026-08-09T00:00:02.000Z',
      expiresAt,
    });

    expect(
      registry.evictShareLinkSessions({
        linkId: 'link-a',
        resourceRef: 'artifact:one',
        revokedAt: '2026-08-09T00:01:00.000Z',
      })
    ).toEqual({ evictedSessionIds: ['session-a'] });
    expect(registry.listActive()).toEqual([
      {
        sessionId: 'session-b',
        linkId: 'link-b',
        resourceRef: 'artifact:one',
        connectedAt: '2026-08-09T00:00:01.000Z',
        expiresAt,
      },
      {
        sessionId: 'session-c',
        linkId: 'link-a',
        resourceRef: 'artifact:two',
        connectedAt: '2026-08-09T00:00:02.000Z',
        expiresAt,
      },
    ]);
  });

  it('rejects session scope mutation under an existing session id', () => {
    const registry = new ShareGrantLiveSessionRegistry();
    registry.registerShareLinkSession({
      sessionId: 'session-a',
      linkId: 'link-a',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:00.000Z',
      expiresAt,
    });

    expect(() =>
      registry.registerShareLinkSession({
        sessionId: 'session-a',
        linkId: 'link-b',
        resourceRef: 'artifact:one',
        connectedAt: '2026-08-09T00:00:00.000Z',
        expiresAt,
      })
    ).toThrow(ShareGrantLiveSessionValidationError);
  });

  it('rejects a new session after its link scope has been evicted', () => {
    const registry = new ShareGrantLiveSessionRegistry();
    registry.evictShareLinkSessions({
      linkId: 'link-a',
      resourceRef: 'artifact:one',
      revokedAt: '2026-08-09T00:01:00.000Z',
    });

    expect(() =>
      registry.registerShareLinkSession({
        sessionId: 'late-session',
        linkId: 'link-a',
        resourceRef: 'artifact:one',
        connectedAt: '2026-08-09T00:02:00.000Z',
        expiresAt,
      })
    ).toThrow('already been revoked');
  });

  it('shares session and revocation state across registry instances', () => {
    const storePath = 'active/shared/tmp/os13-live-session-state.json';
    try {
      const first = new ShareGrantLiveSessionRegistry({ storePath, persist: true });
      first.registerShareLinkSession({
        sessionId: 'session-a',
        linkId: 'link-a',
        resourceRef: 'artifact:one',
        connectedAt: '2026-08-09T00:00:00.000Z',
        expiresAt,
      });
      const second = new ShareGrantLiveSessionRegistry({ storePath, persist: true });
      expect(second.listActive()).toHaveLength(1);
      second.evictShareLinkSessions({
        linkId: 'link-a',
        resourceRef: 'artifact:one',
        revokedAt: '2026-08-09T00:01:00.000Z',
      });
      const third = new ShareGrantLiveSessionRegistry({ storePath, persist: true });
      expect(third.listActive()).toEqual([]);
      expect(() =>
        third.registerShareLinkSession({
          sessionId: 'late-session',
          linkId: 'link-a',
          resourceRef: 'artifact:one',
          connectedAt: '2026-08-09T00:02:00.000Z',
          expiresAt,
        })
      ).toThrow('already been revoked');
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('rejects malformed persisted state before applying any session', () => {
    const storePath = 'active/shared/tmp/os13-malformed-live-session-state.json';
    try {
      safeWriteFile(
        storePath,
        JSON.stringify({
          version: 1,
          sessions: [
            {
              sessionId: 'valid-session',
              linkId: 'link-a',
              resourceRef: 'artifact:one',
              connectedAt: '2026-08-09T00:00:00.000Z',
            },
            {
              sessionId: 'malformed-session',
              linkId: 'link-a',
              resourceRef: 'artifact:two',
              connectedAt: 'not-a-timestamp',
            },
          ],
          revokedScopes: [],
        }),
        { encoding: 'utf8', mkdir: true }
      );

      expect(() => new ShareGrantLiveSessionRegistry({ storePath, persist: true })).toThrow(
        ShareGrantLiveSessionValidationError
      );
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('filters expired registrations after restart and requires legacy sessions to reconnect', () => {
    const storePath = 'active/shared/tmp/os13-live-session-expiry.json';
    const connectedAt = '2026-08-09T00:00:00.000Z';
    const expiry = '2026-08-09T00:01:00.000Z';
    const shared = { linkId: 'link-a', resourceRef: 'artifact:one', connectedAt };
    try {
      safeWriteFile(
        storePath,
        JSON.stringify({
          version: 1,
          sessions: [
            { ...shared, sessionId: 'legacy' },
            { ...shared, sessionId: 'bounded', expiresAt: expiry },
          ],
          revokedScopes: [],
        }),
        { encoding: 'utf8', mkdir: true }
      );
      const readAt = (at: string) =>
        new ShareGrantLiveSessionRegistry({ storePath, persist: true, now: () => Date.parse(at) })
          .listActive()
          .map((session) => session.sessionId);
      expect(readAt(connectedAt)).toEqual(['bounded']);
      expect(readAt(expiry)).toEqual([]);
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('rejects unknown persisted state fields at the catalog boundary', () => {
    const storePath = 'active/shared/tmp/os13-unknown-live-session-state.json';
    try {
      safeWriteFile(
        storePath,
        JSON.stringify({ version: 1, sessions: [], revokedScopes: [], unexpected: true }),
        { encoding: 'utf8', mkdir: true }
      );

      expect(() => new ShareGrantLiveSessionRegistry({ storePath, persist: true })).toThrow(
        ShareGrantLiveSessionValidationError
      );
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });
});
