import { describe, expect, it } from 'vitest';
import type { TerminalRequestLike } from '../presence/bridge/terminal/auth.js';
import { authorizeTerminalRequest } from '../presence/bridge/terminal/auth.js';

function request(
  remoteAddress: string,
  options: { authorization?: string; forwardedFor?: string; url?: string } = {}
): TerminalRequestLike {
  return {
    headers: {
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.forwardedFor ? { 'x-forwarded-for': options.forwardedFor } : {}),
    },
    socket: { remoteAddress },
    url: options.url,
  };
}

describe('terminal authorization boundary', () => {
  it('requires a token for remote access even when no legacy remote switch is present', () => {
    expect(authorizeTerminalRequest(request('10.0.0.5'), undefined, false)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('does not trust a spoofed forwarded loopback address by default', () => {
    expect(
      authorizeTerminalRequest(request('10.0.0.5', { forwardedFor: '127.0.0.1' }), undefined, false)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('uses forwarded peer data only when a trusted proxy is explicitly enabled', () => {
    expect(
      authorizeTerminalRequest(request('10.0.0.5', { forwardedFor: '127.0.0.1' }), undefined, true)
    ).toMatchObject({ ok: true, reason: 'local' });
  });

  it('accepts a bearer token for a remote request', () => {
    expect(
      authorizeTerminalRequest(
        request('10.0.0.5', { authorization: 'Bearer terminal-secret' }),
        'terminal-secret',
        false
      )
    ).toMatchObject({ ok: true, reason: 'token' });
  });
});
