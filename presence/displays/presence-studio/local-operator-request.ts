import type { Request } from 'express';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import {
  isLoopbackAddress,
  PresenceStudioViewerError,
  requirePresenceStudioLocalAdmin,
  resolvePresenceStudioViewerContext,
} from './security.js';

/** Direct transport evidence only; forwarded Host/protocol/address never authorize. */
export function requireLocalOperatorRequest(req: Request, mutation: boolean) {
  const denied = () => new PresenceStudioViewerError(403, 'engine_config_local_session_required');
  if (!isLoopbackAddress(String(req.socket?.remoteAddress || ''))) throw denied();
  if (typeof req.headers.host !== 'string') throw denied();
  const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
  let expected: URL;
  try {
    expected = new URL(protocol + '//' + req.headers.host);
  } catch {
    throw denied();
  }
  const host = expected.hostname.replace(/^\[|\]$/gu, '');
  if (
    expected.username ||
    expected.password ||
    expected.pathname !== '/' ||
    expected.search ||
    expected.hash ||
    (host !== 'localhost' && !isLoopbackAddress(host))
  )
    throw denied();
  if (mutation) {
    const source = req.headers.origin || req.headers.referer;
    if (
      typeof source !== 'string' ||
      !isSameOriginMutation({
        method: 'POST',
        headers: req.headers,
        expectedHost: req.headers.host,
      })
    )
      throw denied();
    try {
      if (new URL(source).origin !== expected.origin) throw denied();
    } catch {
      throw denied();
    }
  }
  const viewer = resolvePresenceStudioViewerContext(req);
  requirePresenceStudioLocalAdmin(viewer);
  return {
    role: 'localadmin',
    source: viewer.source,
    principalId: viewer.principalId,
    loopback: true,
  } as const;
}
