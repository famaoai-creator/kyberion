/**
 * Request-lifetime proof for the explicitly local Concierge Node adapter.
 * NextRequest drops the socket. An opaque ticket lets the Node middleware and
 * route bundles recover that observation without trusting a client IP header.
 * The shared Symbol is process-local, never a credential or persisted secret.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LocalPeerRequest {
  method?: string;
  url?: string;
  headers: { get(name: string): string | null };
}

interface LocalPeerProof {
  address: string;
  target: string;
  expiresAt: number;
}

export const LOCAL_PEER_HEADER = 'x-kyberion-concierge-local-peer';
const STORE_KEY: unique symbol = Symbol.for('kyberion.concierge.local-peer.v1');
const globals = globalThis as typeof globalThis & {
  [STORE_KEY]?: Map<string, LocalPeerProof>;
};
const PROOF_TTL_MS = 30_000;

export function isLoopbackAddress(address: string | undefined): address is string {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isProxyPeerHeader(name: string): boolean {
  const header = name.toLowerCase();
  return (
    header === 'forwarded' ||
    header.startsWith('x-forwarded-') ||
    header === 'x-real-ip' ||
    header === 'x-client-ip' ||
    header === 'true-client-ip' ||
    header === 'cf-connecting-ip' ||
    header === 'fly-client-ip' ||
    header === 'x-vercel-forwarded-for' ||
    header === 'x-envoy-external-address' ||
    header.startsWith('tailscale-') ||
    header.startsWith('cf-access-') ||
    header.startsWith('ngrok-')
  );
}

/** Capture proxy evidence before removing it; Next adds its own forwarded fields. */
export function stripUntrustedPeerHeaders(req: IncomingMessage): boolean {
  let proxied = false;
  for (const name of Object.keys(req.headers)) {
    if (isProxyPeerHeader(name)) {
      proxied = true;
      delete req.headers[name];
    } else if (name.toLowerCase() === LOCAL_PEER_HEADER) {
      delete req.headers[name];
    }
  }
  // Keep IncomingMessage's two header views consistent for downstream adapters.
  for (let index = req.rawHeaders.length - 2; index >= 0; index -= 2) {
    const name = req.rawHeaders[index].toLowerCase();
    if (isProxyPeerHeader(name) || name === LOCAL_PEER_HEADER) {
      req.rawHeaders.splice(index, 2);
    }
  }
  return proxied;
}

export function isLocalAuthority(host: string | string[] | undefined, port: number): boolean {
  if (typeof host !== 'string') return false;
  const suffix = port === 80 ? '' : ':' + port;
  return ['localhost', '127.0.0.1', '[::1]'].some(
    (name) =>
      host.toLowerCase() === name + suffix || (port === 80 && host.toLowerCase() === name + ':80')
  );
}

function requestTarget(req: { method?: string; url?: string }): string | null {
  if (!req.url || !req.method) return null;
  try {
    const url = new URL(req.url, 'http://concierge.local.invalid');
    // Next rebuilds route queries (spaces become '+', equal-key values group).
    // Stable key sorting preserves duplicate-value order while accepting
    // equivalent encodings in the raw Node and reconstructed Next requests.
    url.searchParams.sort();
    const query = url.searchParams.toString();
    return req.method.toUpperCase() + ' ' + url.pathname + (query ? '?' + query : '');
  } catch {
    return null;
  }
}

/** Only call after checking raw socket, Host and original proxy provenance. */
export function attestLocalPeer(req: IncomingMessage, res: ServerResponse): void {
  const address = req.socket.remoteAddress;
  if (!isLoopbackAddress(address)) throw new Error('Local peer proof requires a loopback socket');
  const target = requestTarget(req);
  if (!target) throw new Error('Local peer proof requires a valid request target');
  const store = (globals[STORE_KEY] ??= new Map<string, LocalPeerProof>());
  const ticket = randomBytes(32).toString('base64url');
  store.set(ticket, { address, target, expiresAt: Date.now() + PROOF_TTL_MS });
  req.headers[LOCAL_PEER_HEADER] = ticket;
  req.rawHeaders.push(LOCAL_PEER_HEADER, ticket);
  const cleanup = () => {
    store.delete(ticket);
    clearTimeout(timer);
    res.removeListener('finish', cleanup);
    res.removeListener('close', cleanup);
  };
  const timer = setTimeout(cleanup, PROOF_TTL_MS);
  timer.unref();
  res.once('finish', cleanup);
  res.once('close', cleanup);
}

/** Repeated guards may verify the same request, until its response closes. */
export function verifiedLocalPeerAddress(req: LocalPeerRequest): string | null {
  const ticket = req.headers.get(LOCAL_PEER_HEADER);
  if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const proof = globals[STORE_KEY]?.get(ticket);
  if (!proof || proof.expiresAt <= Date.now() || proof.target !== requestTarget(req)) return null;
  return isLoopbackAddress(proof.address) ? proof.address : null;
}
