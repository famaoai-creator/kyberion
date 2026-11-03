/**
 * Node-only peer admission. Next 16 removes the socket/IP from NextRequest;
 * the explicit local server transports a request-lifetime in-process proof.
 * Neither Host nor forwarded headers confer local-operator authority.
 */
import { isLoopbackAddress, verifiedLocalPeerAddress } from '../../server/local-peer.ts';

interface PeerRequestLike {
  ip?: string;
  method?: string;
  url?: string;
  headers: { get(name: string): string | null };
}

/**
 * Best-known client address for attribution (rate limiting): the verified
 * local-peer proof, else what the framework reports. Never an authority input.
 */
export function conciergePeerAddress(req: PeerRequestLike): string | null {
  return verifiedLocalPeerAddress(req) || req.ip || null;
}

/**
 * Loopback authority comes only from the local server's request-lifetime
 * proof (server/local-peer.ts). `req.ip` is framework/proxy supplied and is
 * never trusted here.
 */
export function isLoopbackPeer(req: PeerRequestLike): boolean {
  return isLoopbackAddress(verifiedLocalPeerAddress(req) ?? undefined);
}
