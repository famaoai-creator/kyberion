import type { NextRequest } from 'next/server';
import type { EngineRuntimeOperatorPrincipal } from '@agent/core/voice/engine-runtime-preferences-operator';
import { requireConciergeMutationAccess } from './api-guard';
import { isLoopbackAddress } from '../../server/local-peer.ts';
import { isLoopbackPeer } from './loopback-peer';
import { resolveConciergeViewer } from './viewer-context';

/** Why the engine settings refused a request (stable wire codes). */
export type EngineConfigDenial =
  'engine_config_authentication_required' | 'engine_config_local_session_required';

/**
 * Pure. Engine settings name local binaries and bridges, so only the person
 * at this machine may read or change them. The Host must be a bare loopback
 * authority; forwarded headers never count.
 */
export function isLocalEngineConfigHost(host: string | null): boolean {
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  return (
    !parsed.username &&
    !parsed.password &&
    parsed.pathname === '/' &&
    !parsed.search &&
    !parsed.hash &&
    (hostname === 'localhost' || isLoopbackAddress(hostname))
  );
}

/**
 * The local operator for `/api/voice/engine-config`: a verified loopback peer
 * (the local server's in-process proof, never `req.ip`), a loopback Host, and
 * a `localadmin` Concierge viewer; a write additionally passes Concierge
 * mutation access (same-origin cookie or a localadmin token). Stricter than
 * presence-studio, which trusted every loopback peer: once an owner is bound,
 * a Concierge loopback request without a session resolves to 401.
 */
export function resolveEngineConfigOperator(
  req: NextRequest,
  mutation: boolean
):
  | { principal: EngineRuntimeOperatorPrincipal; denial?: never; status?: never; response?: never }
  | { principal?: never; denial: EngineConfigDenial; status: 401 | 403; response?: never }
  | { principal?: never; denial?: never; status?: never; response: Response } {
  const local = { denial: 'engine_config_local_session_required', status: 403 } as const;
  if (!isLoopbackPeer(req) || !isLocalEngineConfigHost(req.headers.get('host'))) return local;
  if (mutation) {
    // Rate limiting, an unknown token or a cross-origin write keep their own answer.
    const denied = requireConciergeMutationAccess(req);
    if (denied) return { response: denied };
  }
  const resolved = resolveConciergeViewer(req);
  if (resolved.response) {
    return resolved.response.status === 401
      ? { denial: 'engine_config_authentication_required', status: 401 }
      : local;
  }
  const viewer = resolved.context;
  if (viewer.role !== 'localadmin') return local;
  // The core operator accepts only a loopback localadmin. Here "loopback" is
  // the verified peer + Host above, whatever credential the localadmin viewer
  // presented (cookie, localadmin token, or the open-bootstrap local operator).
  return {
    principal: {
      role: 'localadmin',
      source: 'loopback',
      principalId: viewer.principalId || 'human:concierge-localadmin',
      loopback: true,
    },
  };
}
