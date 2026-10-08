/**
 * Explicit local-operator startup, executed directly by Node 24's native
 * erasable-TypeScript support. Never expose this listener through a proxy or
 * tunnel: a proxy that erases every provenance header is indistinguishable
 * from a local process. Remote deployments must use ordinary dev/start.
 */
import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '@agent/core/logger';
import {
  attestLocalPeer,
  isLocalAuthority,
  isLoopbackAddress,
  stripUntrustedPeerHeaders,
} from './local-peer.ts';

export interface LocalServerOptions {
  port?: number;
  dev?: boolean;
}

const logger = createLogger('concierge-local-server');
const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
const HOST = '127.0.0.1';

export function parseLocalServerOptions(args: string[]): Required<LocalServerOptions> {
  let dev = false;
  let port = 3050;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dev') dev = true;
    else if (args[index] === '--port') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value)) throw new Error('--port requires an integer');
      port = Number(value);
    } else throw new Error('Unknown local server argument: ' + args[index]);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be between 1 and 65535');
  }
  return { dev, port };
}

function listenerPort(server: Server, configured?: number): number {
  if (configured !== undefined) return configured;
  const address = server.address();
  return address && typeof address === 'object' ? address.port : 0;
}

function admitRequest(req: IncomingMessage, port: number): boolean {
  const proxied = stripUntrustedPeerHeaders(req);
  return (
    !proxied &&
    isLoopbackAddress(req.socket.remoteAddress) &&
    isLocalAuthority(req.headers.host, port) &&
    typeof req.url === 'string' &&
    /^\/(?!\/)/.test(req.url)
  );
}

// Next installs its own upgrade listener after the first request. Check the
// event before any listener runs, so that handler cannot bypass admission.
class LocalConciergeServer extends Server {
  localPort?: number;

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'upgrade') {
      const [req, socket] = args as [IncomingMessage, Socket];
      if (!admitRequest(req, listenerPort(this, this.localPort))) {
        socket.destroy();
        return false;
      }
    }
    return super.emit(event, ...args);
  }
}

export function createLocalConciergeServer(
  handle: (req: IncomingMessage, res: ServerResponse) => unknown,
  { port }: { port?: number } = {}
): Server {
  const server = new LocalConciergeServer((req, res) => {
    if (!admitRequest(req, listenerPort(server, port))) {
      res.writeHead(403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('Direct loopback access with a local Host is required.');
      return;
    }
    attestLocalPeer(req, res);
    Promise.resolve()
      .then(() => handle(req, res))
      .catch(() => {
        // Never log request headers: the ephemeral proof is intentionally private.
        logger.error('Local Concierge request failed — handler error | inspect server diagnostics');
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  server.localPort = port;
  return server;
}

export async function startLocalConcierge(
  options: LocalServerOptions = {}
): Promise<{ server: Server; close(): Promise<void> }> {
  const { port = 3050, dev = false } = options;
  const { default: next } = await import('next');
  const app = next({ dev, dir: APP_DIR, hostname: HOST, port, webpack: true });
  await app.prepare();
  const server = createLocalConciergeServer(app.getRequestHandler(), { port });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      server.closeAllConnections();
      // Next owns upgraded HMR sockets; close them before waiting for HTTP drain.
      await app.close();
      await stopped;
    })());
  logger.debug('Local Concierge ready', { url: 'http://' + HOST + ':' + port, dev });
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalConcierge(parseLocalServerOptions(process.argv.slice(2)))
    .then(({ close }) => {
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
          close().catch(() => {
            process.exitCode = 1;
          });
        });
      }
    })
    .catch((error: unknown) => {
      logger.error(
        'Local Concierge startup failed — ' +
          (error instanceof Error ? error.message : String(error)) +
          ' | check the build and local port'
      );
      process.exitCode = 1;
    });
}
