import { describe, expect, it } from 'vitest';
import {
  ShareGrantLiveSessionRegistry,
  ShareGrantLiveSessionValidationError,
} from './share-grant-live-sessions.js';
import { safeRmSync } from './secure-io.js';

describe('ShareGrantLiveSessionRegistry', () => {
  it('evicts only sessions belonging to the revoked link and resource', () => {
    const registry = new ShareGrantLiveSessionRegistry();
    registry.registerShareLinkSession({
      sessionId: 'session-a',
      linkId: 'link-a',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:00.000Z',
    });
    registry.registerShareLinkSession({
      sessionId: 'session-b',
      linkId: 'link-b',
      resourceRef: 'artifact:one',
      connectedAt: '2026-08-09T00:00:01.000Z',
    });
    registry.registerShareLinkSession({
      sessionId: 'session-c',
      linkId: 'link-a',
      resourceRef: 'artifact:two',
      connectedAt: '2026-08-09T00:00:02.000Z',
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
      },
      {
        sessionId: 'session-c',
        linkId: 'link-a',
        resourceRef: 'artifact:two',
        connectedAt: '2026-08-09T00:00:02.000Z',
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
    });

    expect(() =>
      registry.registerShareLinkSession({
        sessionId: 'session-a',
        linkId: 'link-b',
        resourceRef: 'artifact:one',
        connectedAt: '2026-08-09T00:00:00.000Z',
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
        })
      ).toThrow('already been revoked');
    } finally {
      safeRmSync(storePath, { force: true });
    }
  });
});
