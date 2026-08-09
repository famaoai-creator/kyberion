import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenceStudioViewerError, resolvePresenceStudioViewerContext } from './security.js';

function request(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as never;
}

describe('Presence Studio OS viewer scope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats loopback as a server-derived local human scope', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');

    expect(resolvePresenceStudioViewerContext(request('127.0.0.1'))).toEqual({
      principalId: 'human:presence-studio-localadmin',
      tenantSlugs: ['tenant-local'],
      source: 'loopback',
    });
  });

  it('requires a bearer token and server tenant scope for remote access', () => {
    vi.stubEnv('PRESENCE_STUDIO_ALLOW_REMOTE', 'true');
    vi.stubEnv('PRESENCE_STUDIO_TOKEN', 'presence-token');

    expect(() => resolvePresenceStudioViewerContext(request('198.51.100.24'))).toThrow(
      PresenceStudioViewerError
    );
    expect(() =>
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toThrow(/server-side KYBERION_TENANT/);

    vi.stubEnv('KYBERION_TENANT', 'tenant-remote');
    expect(
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toEqual({
      principalId: 'human:presence-studio-token',
      tenantSlugs: ['tenant-remote'],
      source: 'token',
    });
  });
});
