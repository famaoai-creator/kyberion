/**
 * Edge-safe loopback peer detection for the Concierge middleware and the
 * browser-login routes. Mirrors `isLoopbackRequest` in viewer-context.ts
 * (direct peer IP, or proxy headers only when KYBERION_TRUST_PROXY is on) —
 * never the Host header. Kept separate because viewer-context pulls in
 * Node-only modules that the edge runtime cannot load.
 */
interface PeerRequestLike {
  ip?: string;
  headers: { get(name: string): string | null };
}

export function isLoopbackPeer(req: PeerRequestLike): boolean {
  const trustProxy = /^(1|true|yes|on)$/i.test(process.env.KYBERION_TRUST_PROXY ?? '');
  const peerIp =
    req.ip ||
    (trustProxy
      ? req.headers.get('x-real-ip')?.trim() ||
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined);
  return peerIp === '127.0.0.1' || peerIp === '::1' || peerIp === '::ffff:127.0.0.1';
}
