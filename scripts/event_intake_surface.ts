/**
 * event_intake_surface.ts — DL-08 authenticated inbound event intake.
 *
 * `POST /events/<source>` → 202 accepted (also for a redelivered duplicate),
 * 401 bad signature / unknown or disabled source, 413 body too large,
 * 400 non-JSON body, 404 any other path, 405 any other method. `GET /health`
 * answers a static liveness probe for surface reconcile; it reveals no
 * configuration.
 *
 * Why this is not a Chronos route: Chronos API routes resolve a human
 * viewer principal and its tenant scope (`ViewerContext`). Webhook senders
 * are machines with no viewer; their only credential is the per-source HMAC
 * shared secret, and their tenant binding comes from
 * `event-intake-policy.json`, never from the request. Keeping intake on its
 * own loopback listener keeps that machine-principal trust path out of the
 * viewer-scoped surface and lets operators expose it (via a reverse proxy or
 * tunnel) independently of the control plane.
 *
 * Never logs request bodies, headers or secrets — only source, status and
 * event id.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { logger } from '@agent/core/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import {
  loadEventIntakePolicy,
  processInboundEventRequest,
  type EventIntakePolicy,
} from '@agent/core/dot/dot-event-intake';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const EVENT_INTAKE_DEFAULT_HOST = '127.0.0.1';
export const EVENT_INTAKE_DEFAULT_PORT = 8791;
/** Hard ceiling on any body, before the per-source limit is known. */
const ABSOLUTE_MAX_BODY_BYTES = 1024 * 1024;
const SOURCE_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface EventIntakeServerOptions {
  /** Policy loader; defaults to the governed policy (re-read per request, cached by content). */
  loadPolicy?: () => EventIntakePolicy;
  getSecret?: (key: string) => string | null;
  rootDir?: string;
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    ...(status >= 400 ? { connection: 'close' } : {}),
  });
  res.end(payload);
}

/** Collect at most `limit` bytes; resolves null as soon as the limit is exceeded. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
  });
}

export function createEventIntakeServer(options: EventIntakeServerOptions = {}): Server {
  const loadPolicy = options.loadPolicy ?? (() => loadEventIntakePolicy());
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      logger.error(
        `[event-intake] request failed — ${error instanceof Error ? error.name : 'error'} | see daemon log`
      );
      respond(res, 500, { error: 'internal_error' });
    });
  });
  // Slow senders must not pin sockets.
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/health') {
      if (req.method !== 'GET') return respond(res, 405, { error: 'method_not_allowed' });
      return respond(res, 200, { status: 'ok', service: 'event-intake-surface' });
    }
    const match = /^\/events\/([^/]+)$/.exec(pathname);
    if (!match) return respond(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return respond(res, 405, { error: 'method_not_allowed' });
    }
    const source = match[1];
    const policy = loadPolicy();
    const sourcePolicy =
      SOURCE_SEGMENT.test(source) && Object.prototype.hasOwnProperty.call(policy.sources, source)
        ? policy.sources[source]
        : undefined;
    if (!sourcePolicy || !sourcePolicy.enabled) {
      // Same answer for unknown and disabled sources; the body is never read.
      logger.warn(`[event-intake] rejected — source not enabled | status 401`);
      return respond(res, 401, { error: 'unauthorized' });
    }
    const limit = Math.min(sourcePolicy.max_body_bytes, ABSOLUTE_MAX_BODY_BYTES);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      return respond(res, 413, { error: 'payload_too_large' });
    }
    const body = await readBody(req, limit);
    if (body === null) return respond(res, 413, { error: 'payload_too_large' });

    const outcome = processInboundEventRequest({
      source,
      headers: req.headers,
      body,
      policy,
      getSecret: options.getSecret,
      rootDir: options.rootDir,
    });
    if (outcome.status === 202) {
      logger.info(`[event-intake] ${source} ${outcome.result.status} ${outcome.result.event_id}`);
      return respond(res, 202, {
        accepted: true,
        event_id: outcome.result.event_id,
        duplicate: outcome.result.status === 'duplicate',
      });
    }
    logger.warn(`[event-intake] ${source} rejected — ${outcome.code} | status ${outcome.status}`);
    const error =
      outcome.status === 401
        ? 'unauthorized'
        : outcome.status === 413
          ? 'payload_too_large'
          : 'invalid_payload';
    return respond(res, outcome.status, { error });
  }

  return server;
}

export function resolveEventIntakeListen(): { host: string; port: number } {
  const host =
    getRegisteredEnvText('KYBERION_EVENT_INTAKE_HOST')?.trim() || EVENT_INTAKE_DEFAULT_HOST;
  const rawPort = Number(getRegisteredEnvText('KYBERION_EVENT_INTAKE_PORT'));
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536
      ? rawPort
      : EVENT_INTAKE_DEFAULT_PORT;
  return { host, port };
}

export const runEventIntakeSurface = defineScript({
  name: 'event-intake:surface',
  flags: ['json', 'dry-run', 'check'],
  run({ dryRun, check, print }) {
    const { host, port } = resolveEventIntakeListen();
    const policy = loadEventIntakePolicy();
    const result = {
      operation: 'event-intake-surface.listen',
      host,
      port,
      enabled_sources: Object.entries(policy.sources)
        .filter(([, source]) => source.enabled)
        .map(([id]) => id),
    };
    if (dryRun || check) {
      print({ dry_run: true, ...result });
      return { dry_run: true, ...result };
    }
    const server = createEventIntakeServer();
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        logger.error(
          `[event-intake] failed to listen on http://${host}:${port} — ${error.message} | set KYBERION_EVENT_INTAKE_PORT to a free port`
        );
        reject(new ScriptExitError(1, error.message));
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        logger.info(`[event-intake] listening on http://${host}:${port}/events/<source>`);
        const started = { ok: true as const, ...result };
        print(started);
        resolve(started);
      });
    });
  },
});

if (
  isDirectScript(import.meta.url, 'event_intake_surface.ts') ||
  isDirectScript(import.meta.url, 'event_intake_surface.js')
)
  void runEventIntakeSurface();
