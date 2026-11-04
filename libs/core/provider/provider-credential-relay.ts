/**
 * Opt-in loopback credential relay for API-key mode provider CLIs.
 *
 * Default OFF. With `KYBERION_PROVIDER_CREDENTIAL_RELAY=1` a delegated CLI
 * that would otherwise receive its provider's raw API key in env instead
 * gets:
 *
 *   - `<PROVIDER>_BASE_URL` → `http://127.0.0.1:<ephemeral>/<upstream path>`
 *   - `<PROVIDER>_API_KEY`  → a per-turn random placeholder (`kyb-relay-<uuid>`)
 *
 * The relay (in the parent process) holds the real key, accepts only
 * requests that present the current placeholder on a loopback `Host`, swaps
 * in the real credential header, forwards to the configured upstream (TLS;
 * plain HTTP only to a loopback upstream), streams the response back, and is
 * torn down when the turn's spawn env is disposed. The real key never enters
 * the child env, so a prompt-injected child cannot print or exfiltrate it.
 *
 * Scope (this pass):
 *   - Anthropic-compatible (`claude` → `ANTHROPIC_API_KEY` / `x-api-key`) and
 *     OpenAI-compatible (`codex` → `OPENAI_API_KEY` / `Authorization: Bearer`).
 *   - OUT OF SCOPE: OAuth-login CLIs (claude / codex / grok / devin logins kept
 *     in their own home or keychain). When the own API-key var is absent the
 *     relay is not started and the CLI authenticates with its login as before.
 *   - OUT OF SCOPE / follow-up: Bedrock SigV4 request signing and Vertex
 *     access-token minting, WebSocket upgrades, and honoring HTTPS_PROXY for
 *     the relay's own upstream hop.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { logger } from '../core.js';
import {
  PROVIDER_CREDENTIAL_RELAY_ENV_VAR,
  isProviderCredentialRelayEnabled,
} from '../foundation/env.js';
import { resolveTaskProviderEnvironment } from '../foundation/credential-binding.js';
import type { ProviderId } from './provider-permission-profiles.js';

export { PROVIDER_CREDENTIAL_RELAY_ENV_VAR, isProviderCredentialRelayEnabled };
export const CREDENTIAL_RELAY_PLACEHOLDER_PREFIX = 'kyb-relay-';

export type CredentialRelayProtocol = 'anthropic' | 'openai';

interface RelayRoute {
  readonly protocol: CredentialRelayProtocol;
  readonly credentialEnvKey: string;
  readonly baseUrlEnvKey: string;
  readonly defaultUpstream: string;
}

const RELAY_ROUTES: Partial<Record<ProviderId, RelayRoute>> = {
  claude: {
    protocol: 'anthropic',
    credentialEnvKey: 'ANTHROPIC_API_KEY',
    baseUrlEnvKey: 'ANTHROPIC_BASE_URL',
    defaultUpstream: 'https://api.anthropic.com',
  },
  codex: {
    protocol: 'openai',
    credentialEnvKey: 'OPENAI_API_KEY',
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    defaultUpstream: 'https://api.openai.com/v1',
  },
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Idle socket timeout for the relay's upstream hop (streams keep it alive). */
export const CREDENTIAL_RELAY_UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
/** At most one rejection warning per relay per this window. */
const REJECT_WARN_INTERVAL_MS = 30_000;

/** Header names a `Connection` header lists are hop-by-hop too (RFC 9110 §7.6.1). */
function connectionListedHeaders(headers: http.IncomingHttpHeaders): Set<string> {
  const raw = headers.connection;
  const listed = new Set<string>();
  for (const value of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) listed.add(name);
    }
  }
  return listed;
}

export interface CredentialRelayHandle {
  /** Relay origin + upstream base path, e.g. `http://127.0.0.1:54321/v1`. */
  readonly baseUrl: string;
  /** Per-turn placeholder the child must present instead of the real key. */
  readonly placeholder: string;
  readonly closed: boolean;
  /** Stop accepting requests, abort in-flight forwards. Idempotent. */
  close(): void;
}

export interface StartCredentialRelayInput {
  readonly protocol: CredentialRelayProtocol;
  /** The real credential; held only in this closure. */
  readonly credential: string;
  /** Upstream base URL (https, or http to a loopback host only). */
  readonly upstream: string;
}

function parseUpstream(upstream: string): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error('[CREDENTIAL_RELAY_UPSTREAM_INVALID] upstream base URL does not parse');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      '[CREDENTIAL_RELAY_UPSTREAM_INVALID] upstream must be https (plain http only to a loopback host)'
    );
  }
  return url;
}

function sameSecret(presented: string | undefined, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedCredential(
  protocol: CredentialRelayProtocol,
  headers: http.IncomingHttpHeaders
): string | undefined {
  const auth = typeof headers.authorization === 'string' ? headers.authorization : undefined;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
  if (protocol === 'anthropic') {
    const key = headers['x-api-key'];
    return typeof key === 'string' ? key : bearer;
  }
  return bearer;
}

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, '');
  return trimmed === '' ? '' : trimmed;
}

/**
 * Start a loopback relay on 127.0.0.1 with an ephemeral port. Resolves once
 * the port is bound, so the caller can build the child env before spawning.
 * Fails closed: rejects if the port cannot be bound.
 */
export async function startCredentialRelay(
  input: StartCredentialRelayInput
): Promise<CredentialRelayHandle> {
  const upstream = parseUpstream(input.upstream);
  const basePath = normalizeBasePath(upstream.pathname);
  const placeholder = `${CREDENTIAL_RELAY_PLACEHOLDER_PREFIX}${randomUUID()}`;
  const inflight = new Set<http.ClientRequest>();
  let closed = false;
  let port = 0;
  let lastRejectWarnAt = 0;
  let suppressedRejects = 0;

  const reject = (
    res: http.ServerResponse,
    status: number,
    reason: string,
    req: http.IncomingMessage
  ) => {
    const now = Date.now();
    if (now - lastRejectWarnAt >= REJECT_WARN_INTERVAL_MS) {
      logger.warn(
        `[credential-relay] rejected ${req.method ?? '?'} request — ${reason} | next: the child CLI must use the relay base URL and the per-turn placeholder | evidence: status ${status}${suppressedRejects ? `, ${suppressedRejects} earlier rejection(s) not logged` : ''}`
      );
      lastRejectWarnAt = now;
      suppressedRejects = 0;
    } else {
      suppressedRejects += 1;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'credential_relay_rejected', message: reason } }));
  };

  const server = http.createServer((req, res) => {
    if (closed) return reject(res, 503, 'relay closed', req);
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reject(res, 421, 'non-loopback Host header', req);
    }
    if (!sameSecret(presentedCredential(input.protocol, req.headers), placeholder)) {
      return reject(res, 401, 'placeholder credential mismatch', req);
    }
    const rawUrl = req.url ?? '';
    if (!rawUrl.startsWith('/')) return reject(res, 400, 'absolute-form request target', req);
    const target = new URL(rawUrl, 'http://relay.invalid');
    if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
      return reject(res, 404, 'path outside the upstream base path', req);
    }

    const headers: http.OutgoingHttpHeaders = {};
    const requestConnectionListed = connectionListedHeaders(req.headers);
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (
        value === undefined ||
        HOP_BY_HOP_HEADERS.has(lower) ||
        CREDENTIAL_HEADERS.has(lower) ||
        requestConnectionListed.has(lower)
      ) {
        continue;
      }
      headers[lower] = value;
    }
    headers.host = upstream.host;
    if (input.protocol === 'anthropic') headers['x-api-key'] = input.credential;
    else headers.authorization = `Bearer ${input.credential}`;

    const transport = upstream.protocol === 'https:' ? https : http;
    const forward = transport.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        const responseConnectionListed = connectionListedHeaders(upstreamRes.headers);
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          const lower = name.toLowerCase();
          if (
            value === undefined ||
            HOP_BY_HOP_HEADERS.has(lower) ||
            responseConnectionListed.has(lower)
          ) {
            continue;
          }
          responseHeaders[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      }
    );
    inflight.add(forward);
    forward.setTimeout(CREDENTIAL_RELAY_UPSTREAM_IDLE_TIMEOUT_MS, () => {
      forward.destroy(new Error('upstream idle timeout'));
    });
    forward.once('close', () => inflight.delete(forward));
    forward.on('error', (error) => {
      logger.warn(
        `[credential-relay] upstream request failed — ${error.message} | next: check upstream reachability | evidence: ${upstream.host}`
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'credential_relay_upstream_error' } }));
      } else {
        res.destroy();
      }
    });
    req.pipe(forward);
  });
  server.on('upgrade', (_req, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: Error) => {
    throw new Error(
      `[CREDENTIAL_RELAY_UNAVAILABLE] loopback relay could not bind a port: ${error.message}`
    );
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address !== 'object' || !address.port) {
    server.close();
    throw new Error('[CREDENTIAL_RELAY_UNAVAILABLE] loopback relay could not bind a port');
  }
  port = address.port;
  // A leaked relay must not keep the parent alive; live sockets still do.
  server.unref();
  logger.debug(
    `[credential-relay] started on 127.0.0.1:${port} (protocol=${input.protocol}, upstream=${upstream.protocol}//${upstream.host}${basePath})`
  );

  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    placeholder,
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of inflight) request.destroy();
      inflight.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}

export interface PreparedProviderCredentialRelay {
  readonly provider: ProviderId;
  readonly relay: CredentialRelayHandle;
}

let failClosedPathsAnnounced = false;

/** Once per process: name the launch paths that run without an API key. */
function announceFailClosedPaths(): void {
  if (failClosedPathsAnnounced) return;
  failClosedPathsAnnounced = true;
  logger.warn(
    `[credential-relay] ${PROVIDER_CREDENTIAL_RELAY_ENV_VAR} is on — claude/codex delegations use the loopback relay; these paths run WITHOUT ANTHROPIC_API_KEY/OPENAI_API_KEY (own login or no auth): agent-adapter codex exec / claude -p, codex app-server harness, ACP mediator, claude-agent SDK, herdr pane agents, pty shells, process-actuator | next: use OAuth logins for those paths or unset the flag | evidence: api-credential-proof-boundary.md launch-site table`
  );
}

function relayRouteFor(provider: ProviderId, baseEnv: NodeJS.ProcessEnv): RelayRoute | undefined {
  if (!isProviderCredentialRelayEnabled(baseEnv)) return undefined;
  announceFailClosedPaths();
  return RELAY_ROUTES[provider];
}

/**
 * Operator- or tenant-configured upstream base URL. When the task has a bound
 * provider environment, only that environment may name the upstream — a
 * tenant credential is never routed to the operator's gateway.
 */
function configuredUpstreamFor(
  provider: ProviderId,
  route: RelayRoute,
  baseEnv: NodeJS.ProcessEnv
): string | undefined {
  let bound: NodeJS.ProcessEnv | undefined;
  try {
    bound = resolveTaskProviderEnvironment(provider);
  } catch {
    bound = undefined;
  }
  return (bound ?? baseEnv)[route.baseUrlEnvKey]?.trim() || undefined;
}

/** Cheap pre-check: flag on and `provider` has a relay route (no env build). */
export function providerHasCredentialRelayRoute(
  provider: ProviderId,
  baseEnv: NodeJS.ProcessEnv = process.env
): boolean {
  return relayRouteFor(provider, baseEnv) !== undefined;
}

/** True when {@link prepareProviderCredentialRelay} would start a relay. */
export function providerCredentialRelayApplies(input: {
  provider: ProviderId;
  credentialEnv: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
}): boolean {
  const route = relayRouteFor(input.provider, input.baseEnv ?? process.env);
  return Boolean(route && input.credentialEnv[route.credentialEnvKey]);
}

/**
 * Async half, run at the launch site before the env is built: start the
 * relay for `provider` when the flag is on, the provider has a relay route
 * and its own API key is present in `credentialEnv` (the allowlisted child
 * env). Returns null otherwise — including OAuth-login mode, where no API
 * key var exists and the CLI's own login is used (out of scope).
 */
export async function prepareProviderCredentialRelay(input: {
  provider: ProviderId;
  credentialEnv: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
}): Promise<PreparedProviderCredentialRelay | null> {
  const baseEnv = input.baseEnv ?? process.env;
  const route = relayRouteFor(input.provider, baseEnv);
  if (!route) return null;
  const credential = input.credentialEnv[route.credentialEnvKey];
  if (!credential) return null;
  const configuredUpstream = configuredUpstreamFor(input.provider, route, baseEnv);
  const relay = await startCredentialRelay({
    protocol: route.protocol,
    credential,
    upstream: configuredUpstream || route.defaultUpstream,
  });
  return { provider: input.provider, relay };
}

/**
 * Sync half, applied to the allowlisted provider child env. Flag off, no
 * route, or no own API key ⇒ env unchanged. With a prepared relay the key is
 * replaced by the placeholder and `*_BASE_URL` points at the relay. With the
 * flag on but no prepared relay (a sync launch site that cannot start one)
 * the key is dropped — fail closed: the raw key never reaches the child.
 */
export function applyProviderCredentialRelay(input: {
  provider: ProviderId;
  env: NodeJS.ProcessEnv;
  baseEnv?: NodeJS.ProcessEnv;
  prepared?: PreparedProviderCredentialRelay | null;
}): NodeJS.ProcessEnv {
  const route = relayRouteFor(input.provider, input.baseEnv ?? process.env);
  if (!route || !input.env[route.credentialEnvKey]) return input.env;
  const prepared =
    input.prepared && input.prepared.provider === input.provider && !input.prepared.relay.closed
      ? input.prepared.relay
      : undefined;
  if (!prepared) {
    logger.warn(
      `[credential-relay] dropped ${route.credentialEnvKey} from the ${input.provider} child env — relay enabled but this launch site started no relay | next: launch through buildDelegationSpawnEnvWithRelay, or unset ${PROVIDER_CREDENTIAL_RELAY_ENV_VAR} | evidence: provider=${input.provider}`
    );
    const env = { ...input.env };
    delete env[route.credentialEnvKey];
    return env;
  }
  return {
    ...input.env,
    [route.credentialEnvKey]: prepared.placeholder,
    [route.baseUrlEnvKey]: prepared.baseUrl,
  };
}
