import { describe, expect, it, vi } from 'vitest';
import {
  ShareGrantAuthorizationError,
  ShareGrantGraph,
  ShareGrantValidationError,
  parsePersistedEnvelope,
} from './share-grant-graph.js';
import { computeLedgerEntryHash, GENESIS_HASH } from './chain-integrity.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';

const HMAC_KEY = 'os13-share-graph-test-key-123456789';

function actor(name = 'owner') {
  return {
    principalId: `principal:${name}`,
    authenticated: true as const,
    tenantSlugs: 'all' as const,
  };
}

function createGraph(now = Date.parse('2026-08-09T00:00:00.000Z')) {
  let current = now;
  return {
    advance(ms: number) {
      current += ms;
    },
    graph: new ShareGrantGraph({
      persist: false,
      hmacKey: HMAC_KEY,
      now: () => current,
      authorizeActor: () => undefined,
      resolveTenant: () => ({ status: 'active' }),
    }),
  };
}

describe('ShareGrantGraph', () => {
  it('keeps delegated access tied to operate across grant order and revocation', () => {
    const cases = [false, true].flatMap((strictFirst) =>
      [false, true].flatMap((revokeOperate) =>
        [false, true].map((tighten) => ({ strictFirst, revokeOperate, tighten }))
      )
    );
    type State =
      | { stage: 'initial' }
      | {
          stage: 'resolved';
          scenario: (typeof cases)[number];
          intermediary: ReturnType<ShareGrantGraph['getEffectiveAccess']>;
          leaf: ReturnType<ShareGrantGraph['getEffectiveAccess']>;
        };
    const result = checkFiniteStateSafety<State>({
      initial: [{ stage: 'initial' }],
      key: JSON.stringify,
      next: (state) =>
        state.stage === 'initial'
          ? cases.map((scenario) => {
              let highestTier: 'public' | 'confidential' = 'public';
              const graph = new ShareGrantGraph({
                persist: false,
                authorizeActor: () => undefined,
                resolveTenant: () => ({ status: 'active' }),
                resolveProvenance: () => ({
                  missionId: 'MSN-GRANT',
                  highestTier,
                  tenants: ['tenant-a'],
                  prohibitExternal: false,
                  observationIds: [],
                }),
              });
              const resourceRef = 'artifact:model';
              graph.registerResource({
                resourceRef,
                tenantSlug: 'tenant-a',
                ownerPrincipal: 'principal:owner',
                taint: 'public',
                provenanceMissionId: 'MSN-GRANT',
                actor: actor(),
              });
              const grant = (role: 'view' | 'operate', audienceFloor: 'public' | 'confidential') =>
                graph.grantEdge({
                  resourceRef,
                  actor: actor(),
                  grantee: 'principal:manager',
                  role,
                  audienceFloor,
                });
              if (scenario.strictFirst) grant('view', 'confidential');
              const operate = grant('operate', 'public');
              if (!scenario.strictFirst) grant('view', 'confidential');
              graph.grantEdge({
                resourceRef,
                actor: actor('manager'),
                grantee: 'principal:viewer',
                role: 'view',
                audienceFloor: 'confidential',
              });
              if (scenario.revokeOperate) graph.revokeEdge(operate.edgeId, actor());
              if (scenario.tighten) highestTier = 'confidential';
              return {
                action: 'resolve',
                state: {
                  stage: 'resolved',
                  scenario,
                  intermediary: graph.getEffectiveAccess(resourceRef, 'principal:manager'),
                  leaf: graph.getEffectiveAccess(resourceRef, 'principal:viewer'),
                },
              };
            })
          : [],
      invariants: {
        floorAndDelegation: (state) => {
          if (state.stage === 'initial') return true;
          const canOperate = !state.scenario.revokeOperate && !state.scenario.tighten;
          return (
            state.intermediary?.audienceFloor === 'confidential' &&
            state.intermediary.role === (canOperate ? 'operate' : 'view') &&
            Boolean(state.leaf) === canOperate
          );
        },
      },
    });
    expect(result).toMatchObject({ status: 'verified', transitions: 8 });
  });

  it('reads a revocation written by another persisted graph before accepting a session', () => {
    const storePath = 'active/shared/tmp/share-grant-cross-instance.jsonl';
    const options = {
      storePath,
      persist: true,
      hmacKey: HMAC_KEY,
      authorizeActor: () => undefined,
      resolveTenant: () => ({ status: 'active' as const }),
    };
    const resourceRef = 'artifact:shared-instance';
    try {
      const first = new ShareGrantGraph(options);
      first.registerResource({
        resourceRef,
        actor: actor(),
        tenantSlug: 'tenant-a',
        taint: 'public',
      });
      const delegation = first.grantEdge({
        resourceRef,
        actor: actor(),
        grantee: 'principal:manager',
        role: 'operate',
      });
      const link = first.issueShareLink({ resourceRef, actor: actor('manager'), role: 'view' });
      const second = new ShareGrantGraph(options);
      expect(second.isShareLinkActive(resourceRef, link.linkId)).toBe(true);
      first.revokeEdge(delegation.edgeId, actor());
      expect(second.isShareLinkActive(resourceRef, link.linkId)).toBe(false);
      expect(second.resolveShareLink(resourceRef, link.token)).toBeNull();
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('validates persisted envelope and event shapes before hash verification', () => {
    const envelope = {
      version: 1,
      previousHash: GENESIS_HASH,
      event: {
        type: 'resource_registered' as const,
        resource: {
          resourceRef: 'artifact:parser',
          tenantSlug: 'tenant-a',
          ownerPrincipal: 'principal:owner',
          taint: 'confidential' as const,
          registeredAt: '2026-08-09T00:00:00.000Z',
        },
      },
      hash: 'a'.repeat(64),
    };

    expect(parsePersistedEnvelope(envelope)).toEqual(envelope);
    expect(() =>
      parsePersistedEnvelope({
        ...envelope,
        event: { ...envelope.event, resource: { ...envelope.event.resource, taint: 'publicity' } },
      })
    ).toThrow('taint');
  });

  it.each([
    ['primitive root', null],
    ['missing envelope hash', { version: 1, previousHash: GENESIS_HASH, event: {} }],
    [
      'invalid edge role',
      {
        version: 1,
        previousHash: GENESIS_HASH,
        hash: 'a'.repeat(64),
        event: {
          type: 'edge_granted',
          edge: {
            edgeId: 'edge-1',
            resourceRef: 'artifact:parser',
            grantor: 'principal:owner',
            grantee: 'principal:viewer',
            granteeTenantSlug: 'tenant-a',
            role: 'admin',
            audienceFloor: 'public',
            grantedBy: 'principal:owner',
            grantedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      },
    ],
  ])('rejects %s before replay', (_label, value) => {
    expect(() => parsePersistedEnvelope(value)).toThrow();
  });

  it('rejects an external persistent store path before loading or writing it', () => {
    expect(
      () =>
        new ShareGrantGraph({
          storePath: '/tmp/share-grant-external.jsonl',
          persist: true,
          hmacKey: HMAC_KEY,
        })
    ).toThrow('RESOURCE_PATH_SCOPE');
  });

  it('recomputes reachability so intermediary revocation is reversible', () => {
    const { graph } = createGraph();
    graph.registerResource({
      resourceRef: 'mission:view:alpha',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'confidential',
      actor: actor(),
    });
    const intermediary = graph.grantEdge({
      resourceRef: 'mission:view:alpha',
      actor: actor(),
      grantee: 'principal:manager',
      role: 'operate',
    });
    graph.grantEdge({
      resourceRef: 'mission:view:alpha',
      actor: actor('manager'),
      grantee: 'principal:reviewer',
      role: 'view',
    });

    expect(graph.getEffectiveAccess('mission:view:alpha', 'principal:reviewer')).toMatchObject({
      role: 'view',
    });
    graph.revokeEdge(intermediary.edgeId, actor());
    expect(graph.getEffectiveAccess('mission:view:alpha', 'principal:manager')).toBeNull();
    expect(graph.getEffectiveAccess('mission:view:alpha', 'principal:reviewer')).toBeNull();

    graph.grantEdge({
      resourceRef: 'mission:view:alpha',
      actor: actor(),
      grantee: 'principal:manager',
      role: 'operate',
    });
    expect(graph.getEffectiveAccess('mission:view:alpha', 'principal:reviewer')).toMatchObject({
      role: 'view',
    });
  });

  it('denies view principals from creating downstream grants', () => {
    const { graph } = createGraph();
    graph.registerResource({
      resourceRef: 'surface:operator',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'public',
      actor: actor(),
    });
    graph.grantEdge({
      resourceRef: 'surface:operator',
      actor: actor(),
      grantee: 'principal:viewer',
      role: 'view',
    });
    expect(() =>
      graph.grantEdge({
        resourceRef: 'surface:operator',
        actor: actor('viewer'),
        grantee: 'principal:other',
        role: 'view',
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('requires authorization even when an edge was already revoked', () => {
    const { graph } = createGraph();
    graph.registerResource({
      resourceRef: 'artifact:revoked-edge',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'public',
      actor: actor(),
    });
    const edge = graph.grantEdge({
      resourceRef: 'artifact:revoked-edge',
      actor: actor(),
      grantee: 'principal:viewer',
      role: 'view',
    });
    graph.revokeEdge(edge.edgeId, actor());

    expect(() =>
      graph.revokeEdge(edge.edgeId, {
        ...actor('intruder'),
        authenticated: false,
      } as never)
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('stores only a hash for a 128-bit share token and honors TTL/revoke', () => {
    const clock = createGraph();
    const { graph: shareGraph, advance } = clock;
    shareGraph.registerResource({
      resourceRef: 'artifact:brief',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'public',
      actor: actor(),
    });
    const link = shareGraph.issueShareLink({
      resourceRef: 'artifact:brief',
      actor: actor(),
      role: 'view',
      ttlMs: 30_000,
    });

    expect(Buffer.from(link.token, 'base64url')).toHaveLength(16);
    expect(shareGraph.listShareLinks()[0]).not.toHaveProperty('token');
    expect(shareGraph.listShareLinks()[0]).not.toHaveProperty('tokenHash');
    expect(shareGraph.resolveShareLink('artifact:brief', link.token)).toMatchObject({
      role: 'view',
    });

    advance(31_000);
    expect(shareGraph.resolveShareLink('artifact:brief', link.token)).toBeNull();

    const second = shareGraph.issueShareLink({
      resourceRef: 'artifact:brief',
      actor: actor(),
      role: 'view',
    });
    shareGraph.revokeShareLink(second.linkId, actor());
    expect(shareGraph.resolveShareLink('artifact:brief', second.token)).toBeNull();
  });

  it('persists link revocation before evicting its live sessions and retries after an eviction failure', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-eviction.jsonl';
    const evictShareLinkSessions = vi
      .fn()
      .mockImplementationOnce(() => {
        const raw = String(safeReadFile(storePath, { encoding: 'utf8' }));
        expect(raw).toContain('"type":"link_revoked"');
        throw new Error('session backend unavailable');
      })
      .mockReturnValueOnce({ evictedSessionIds: ['session-1'] });
    const registerShareLinkSession = vi.fn((input) => ({ ...input }));
    try {
      const graph = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        liveSessionEvictor: { evictShareLinkSessions, registerShareLinkSession },
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      graph.registerResource({
        resourceRef: 'artifact:eviction',
        tenantSlug: 'tenant-a',
        ownerPrincipal: 'principal:owner',
        taint: 'public',
        actor: actor(),
      });
      const link = graph.issueShareLink({
        resourceRef: 'artifact:eviction',
        actor: actor(),
        role: 'view',
      });

      expect(() => graph.revokeShareLink(link.linkId, actor())).toThrow(
        'session backend unavailable'
      );
      expect(graph.resolveShareLink('artifact:eviction', link.token)).toBeNull();
      graph.revokeShareLink(link.linkId, actor());
      expect(evictShareLinkSessions).toHaveBeenNthCalledWith(2, {
        linkId: link.linkId,
        resourceRef: 'artifact:eviction',
        revokedAt: expect.any(String),
      });
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('registers a live session only through a currently valid share-link token', () => {
    const registerShareLinkSession = vi.fn((input) => ({ ...input }));
    const graphWithSessions = new ShareGrantGraph({
      persist: false,
      hmacKey: HMAC_KEY,
      liveSessionEvictor: {
        registerShareLinkSession,
        evictShareLinkSessions: vi.fn(),
      },
      authorizeActor: () => undefined,
      resolveTenant: () => ({ status: 'active' }),
    });
    graphWithSessions.registerResource({
      resourceRef: 'artifact:session',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'public',
      actor: actor(),
    });
    const link = graphWithSessions.issueShareLink({
      resourceRef: 'artifact:session',
      actor: actor(),
      role: 'view',
    });

    expect(
      graphWithSessions.openShareLinkSession({
        resourceRef: 'artifact:session',
        token: link.token,
        sessionId: 'session-1',
        connectedAt: '2026-08-09T00:00:00.000Z',
      })
    ).toMatchObject({ linkId: link.linkId, resourceRef: 'artifact:session' });
    expect(
      graphWithSessions.openShareLinkSession({
        resourceRef: 'artifact:session',
        token: 'invalid-token',
        sessionId: 'session-2',
        connectedAt: '2026-08-09T00:00:01.000Z',
      })
    ).toBeNull();
    expect(registerShareLinkSession).toHaveBeenCalledOnce();
  });

  it('rejects a grant whose audience floor is less restrictive than the resource taint', () => {
    const { graph } = createGraph();
    graph.registerResource({
      resourceRef: 'artifact:private',
      tenantSlug: 'tenant-a',
      ownerPrincipal: 'principal:owner',
      taint: 'personal',
      actor: actor(),
    });
    expect(() =>
      graph.issueShareLink({
        resourceRef: 'artifact:private',
        actor: actor(),
        role: 'view',
        audienceFloor: 'public',
      })
    ).toThrow('would broaden personal taint');
  });

  it('replays the append-only graph without persisting the plaintext token', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-replay.jsonl';
    try {
      const first = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      first.registerResource({
        resourceRef: 'mission:view:replay',
        tenantSlug: 'tenant-a',
        ownerPrincipal: 'principal:owner',
        taint: 'confidential',
        actor: actor(),
      });
      const link = first.issueShareLink({
        resourceRef: 'mission:view:replay',
        actor: actor(),
        role: 'view',
      });
      const raw = String(safeReadFile(storePath, { encoding: 'utf8' }));
      expect(raw).not.toContain(link.token);
      expect(raw).toContain(link.linkId);
      const second = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      expect(second.resolveShareLink('mission:view:replay', link.token)).toMatchObject({
        role: 'view',
      });
      second.revokeShareLink(link.linkId, actor());
      const third = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      expect(third.resolveShareLink('mission:view:replay', link.token)).toBeNull();
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('replays a durable link revocation into the live-session evictor', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-replay-eviction.jsonl';
    try {
      const first = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      first.registerResource({
        resourceRef: 'artifact:replay-eviction',
        tenantSlug: 'tenant-a',
        ownerPrincipal: 'principal:owner',
        taint: 'public',
        actor: actor(),
      });
      const link = first.issueShareLink({
        resourceRef: 'artifact:replay-eviction',
        actor: actor(),
        role: 'view',
      });
      first.revokeShareLink(link.linkId, actor());

      const evictShareLinkSessions = vi.fn();
      new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        liveSessionEvictor: {
          registerShareLinkSession: vi.fn((input) => ({ ...input })),
          evictShareLinkSessions,
        },
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      expect(evictShareLinkSessions).toHaveBeenCalledWith({
        linkId: link.linkId,
        resourceRef: 'artifact:replay-eviction',
        revokedAt: expect.any(String),
      });
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('fails closed when no trusted authorizer is configured', () => {
    const graph = new ShareGrantGraph({ persist: false, hmacKey: HMAC_KEY });
    expect(() =>
      graph.registerResource({
        resourceRef: 'artifact:untrusted',
        tenantSlug: 'tenant-a',
        ownerPrincipal: 'principal:owner',
        taint: 'public',
        actor: actor(),
      })
    ).toThrow(ShareGrantAuthorizationError);
  });

  it('rejects a tampered persisted ledger before exposing graph state', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-tamper.jsonl';
    try {
      const first = new ShareGrantGraph({
        storePath,
        persist: true,
        hmacKey: HMAC_KEY,
        authorizeActor: () => undefined,
        resolveTenant: () => ({ status: 'active' }),
      });
      first.registerResource({
        resourceRef: 'artifact:tamper',
        tenantSlug: 'tenant-a',
        ownerPrincipal: 'principal:owner',
        taint: 'public',
        actor: actor(),
      });
      const raw = String(safeReadFile(storePath, { encoding: 'utf8' }));
      safeWriteFile(storePath, raw.replace('artifact:tamper', 'artifact:forged'));
      expect(
        () =>
          new ShareGrantGraph({
            storePath,
            persist: true,
            hmacKey: HMAC_KEY,
            authorizeActor: () => undefined,
            resolveTenant: () => ({ status: 'active' }),
          })
      ).toThrow(ShareGrantValidationError);
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('fails closed when a validly chained legacy resource event lacks tenant binding', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-legacy.jsonl';
    try {
      const event = {
        type: 'resource_registered' as const,
        resource: {
          resourceRef: 'artifact:legacy',
          ownerPrincipal: 'principal:owner',
          taint: 'public' as const,
          registeredAt: '2026-08-09T00:00:00.000Z',
        },
      };
      const unsigned = { version: 1 as const, previousHash: GENESIS_HASH, event };
      const hash = computeLedgerEntryHash(unsigned, { alg: 'hmac-sha256', key: HMAC_KEY });
      safeWriteFile(storePath, `${JSON.stringify({ ...unsigned, hash })}\n`);

      expect(
        () =>
          new ShareGrantGraph({
            storePath,
            persist: true,
            hmacKey: HMAC_KEY,
            authorizeActor: () => undefined,
            resolveTenant: () => ({ status: 'active' }),
          })
      ).toThrow(ShareGrantValidationError);
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });

  it('rejects a directory replacing the persisted grant ledger', () => {
    const storePath = 'active/shared/tmp/os13-share-grant-directory.jsonl';
    try {
      safeMkdir(storePath, { recursive: true });
      expect(
        () =>
          new ShareGrantGraph({
            storePath,
            persist: true,
            hmacKey: HMAC_KEY,
            authorizeActor: () => undefined,
            resolveTenant: () => ({ status: 'active' }),
          })
      ).toThrow(/share-grant ledger must be a regular file/);
    } finally {
      safeRmSync(storePath, { recursive: true, force: true });
    }
  });
});
