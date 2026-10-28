import * as http from 'node:http';
import { logger } from '@agent/core/core';
import type { FrameSource } from './frame-source.js';
import type { InputInjector } from './input-injector.js';
import { renderViewerHtml } from './viewer-html.js';

export type MirrorState = 'starting' | 'live' | 'degraded';

export interface MirrorServerOptions {
  frameSource: FrameSource;
  injector?: InputInjector;
  deviceLabel?: string;
  /** Session token issued at start_screen_stream; required on every endpoint. */
  token: string;
  fps?: number;
  port?: number;
}

export interface MirrorServerHandle {
  port: number;
  viewerUrl: string;
  streamUrl: string;
  close(): Promise<void>;
  status(): {
    state: MirrorState;
    fps: number;
    last_error?: string;
    device: string;
    tap_enabled: boolean;
  };
}

const BOUNDARY = 'kyberion-frame';
const MAX_STREAM_CLIENTS = 8;
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Loopback MJPEG mirror. An async capture loop (never overlapping, never
 * blocking the event loop) feeds every connected /stream.mjpeg client;
 * POST /tap injects a device-point coordinate through the platform
 * InputInjector. Read-only when no injector is supplied.
 *
 * Security boundary: loopback alone is NOT sufficient — any local process or
 * cross-origin browser page could otherwise watch the screen and inject
 * taps without an individual approval. Every endpoint therefore requires
 * the per-session token issued at stream start (via ?token= or the
 * x-kyberion-mirror-token header), browser requests must present a loopback
 * Origin / a same-site fetch-site header, and every tap is audit-logged
 * through the governed logger so the trail matches actuator audit rules.
 */
export function startMirrorServer(options: MirrorServerOptions): Promise<MirrorServerHandle> {
  const host = '127.0.0.1';
  const token = options.token;
  if (!token) throw new Error('mirror server requires a session token');
  const rawFps = options.fps ?? 3;
  const targetFps = Number.isFinite(rawFps) ? Math.min(Math.max(rawFps, 0.5), 10) : 3;
  const intervalMs = Math.round(1000 / targetFps);
  const deviceLabel = options.deviceLabel ?? options.frameSource.label;
  const injector = options.injector;

  let state: MirrorState = 'starting';
  let lastError: string | undefined;
  let framesEmitted = 0;
  let windowStart = Date.now();
  let measuredFps = 0;
  let failStreak = 0;
  let capturing = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const clients = new Set<http.ServerResponse>();

  const tick = async (): Promise<void> => {
    if (stopped || capturing) return;
    capturing = true;
    try {
      const frame = await options.frameSource.grab();
      failStreak = 0;
      framesEmitted += 1;
      const now = Date.now();
      if (now - windowStart >= 2000) {
        measuredFps = (framesEmitted * 1000) / (now - windowStart);
        framesEmitted = 0;
        windowStart = now;
      }
      if (state !== 'live') state = 'live';
      const chunk = Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\ncontent-type: image/png\r\ncontent-length: ${frame.length}\r\n\r\n`
        ),
        frame,
        Buffer.from('\r\n'),
      ]);
      for (const res of clients) {
        if (res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
          res.destroy();
          clients.delete(res);
          continue;
        }
        res.write(chunk, (err) => {
          if (err) clients.delete(res);
        });
      }
    } catch (error: unknown) {
      failStreak += 1;
      lastError = error instanceof Error ? error.message : String(error);
      if (failStreak >= 3) state = 'degraded';
    } finally {
      capturing = false;
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  timer = setTimeout(() => void tick(), 0);

  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (req.headers['x-kyberion-mirror-token'] === token) return true;
    return url.searchParams.get('token') === token;
  };
  const browserOriginOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers['origin'];
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return false;
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite.toLowerCase())) {
      return false;
    }
    return true;
  };
  const deny = (res: http.ServerResponse, status: number, error: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (!authorized(req, url)) {
      deny(res, 403, 'mirror session token required');
      return;
    }
    if (!browserOriginOk(req)) {
      deny(res, 403, 'cross-origin request rejected');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const body = renderViewerHtml({ deviceLabel, interactive: Boolean(injector) });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stream.mjpeg') {
      if (clients.size >= MAX_STREAM_CLIENTS) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'too many stream clients' }));
        return;
      }
      res.writeHead(200, {
        'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'cache-control': 'no-cache, no-store',
        connection: 'close',
      });
      res.write(`--${BOUNDARY}\r\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/tap') {
      if (!injector) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'input injection unavailable' }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 4096) req.destroy();
      });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body) as { x?: number; y?: number };
            if (
              typeof parsed.x !== 'number' ||
              typeof parsed.y !== 'number' ||
              !Number.isFinite(parsed.x) ||
              !Number.isFinite(parsed.y)
            ) {
              throw new Error('tap requires finite numeric x and y');
            }
            await injector.tap(parsed.x, parsed.y);
            // Mirror-session audit trail: each HTTP tap is a device input
            // injection — log it like an actuator apply op.
            logger.info(
              `[SHARED_MOBILE] mirror tap injected on ${deviceLabel} at (${parsed.x}, ${parsed.y})`
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, x: parsed.x, y: parsed.y }));
          } catch (error: unknown) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
            );
          }
        })();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          state,
          fps: measuredFps,
          last_error: lastError,
          device: deviceLabel,
          tap_enabled: Boolean(injector),
        })
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      stopped = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      logger.success(
        `[SHARED_MOBILE] mirror live for ${deviceLabel} at http://${host}:${port}/ (${targetFps} fps target${injector ? ', tap enabled' : ', read-only'})`
      );
      resolve({
        port,
        viewerUrl: `http://${host}:${port}/`,
        streamUrl: `http://${host}:${port}/stream.mjpeg`,
        status: () => ({
          state,
          fps: measuredFps,
          last_error: lastError,
          device: deviceLabel,
          tap_enabled: Boolean(injector),
        }),
        close: () =>
          new Promise<void>((done) => {
            stopped = true;
            if (timer) clearTimeout(timer);
            for (const res of clients) res.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
