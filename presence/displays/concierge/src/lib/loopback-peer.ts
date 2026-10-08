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

export function conciergePeerAddress(req: PeerRequestLike): string | null {
  return verifiedLocalPeerAddress(req) || req.ip || null;
}

export function isLoopbackPeer(req: PeerRequestLike): boolean {
  return isLoopbackAddress(conciergePeerAddress(req) ?? undefined);
}
