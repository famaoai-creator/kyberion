import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import { attestLocalPeer } from '../server/local-peer.ts';

/** Synchronous unit fixture for the same socket-to-NextRequest admission seam. */
export function withLocalPeerRequest<T>(request: NextRequest, run: (req: NextRequest) => T): T {
  const url = new URL(request.url);
  const raw = {
    method: request.method,
    url: url.pathname + url.search,
    socket: { remoteAddress: '127.0.0.1' },
    headers: Object.fromEntries(request.headers),
    rawHeaders: [],
  } as unknown as IncomingMessage;
  const response = new EventEmitter() as ServerResponse;
  attestLocalPeer(raw, response);
  const verified = new NextRequest(request, { headers: raw.headers as Record<string, string> });
  try {
    return run(verified);
  } finally {
    response.emit('finish');
  }
}
