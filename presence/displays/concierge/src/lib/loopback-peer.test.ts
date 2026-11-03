import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { withLocalPeerRequest } from '../../test/local-peer-fixture';
import { conciergePeerAddress, isLoopbackPeer } from './loopback-peer';

describe('concierge loopback peer proof', () => {
  it('never treats a framework-reported req.ip as loopback authority', () => {
    const req = Object.assign(new NextRequest('http://127.0.0.1:3050/api/me'), {
      ip: '127.0.0.1',
    });
    expect(isLoopbackPeer(req)).toBe(false);
    // Attribution may still use it.
    expect(conciergePeerAddress(req)).toBe('127.0.0.1');
  });

  it('accepts only the local server’s request-lifetime proof', () => {
    expect(
      withLocalPeerRequest(new NextRequest('http://127.0.0.1:3050/api/me'), isLoopbackPeer)
    ).toBe(true);
  });
});
