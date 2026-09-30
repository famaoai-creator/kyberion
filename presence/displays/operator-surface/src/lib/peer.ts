import { getRegisteredEnvBool } from '@agent/core/foundation/env';

/**
 * Edge-safe peer/loopback decision shared by the middleware, route handlers
 * and server components. Loopback is decided from the real socket peer (or,
 * only with KYBERION_TRUST_PROXY, the proxy-set forwarding headers) — never
 * from the Host header.
 */

/** Set (and always overwritten) by middleware so server components can read the decision. */
export const LOOPBACK_HEADER = 'x-kyberion-loopback';

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

interface PeerRequest {
  ip?: string;
  headers: { get(name: string): string | null };
}

export function resolvePeerIp(req: PeerRequest): string | undefined {
  if (req.ip) return req.ip;
  if (getRegisteredEnvBool('KYBERION_TRUST_PROXY') !== true) return undefined;
  return (
    req.headers.get('x-real-ip')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  );
}

export function isLoopbackPeer(req: PeerRequest): boolean {
  const peer = resolvePeerIp(req);
  return Boolean(peer && LOOPBACK_ADDRESSES.includes(peer));
}

/**
 * Loopback for a request that already passed the middleware: the middleware
 * strips the inbound header and re-sets it from the socket peer, so its value
 * is trustworthy; the direct peer check covers callers that bypass it.
 */
export function isLoopbackRequest(req: PeerRequest): boolean {
  return req.headers.get(LOOPBACK_HEADER) === '1' || isLoopbackPeer(req);
}
