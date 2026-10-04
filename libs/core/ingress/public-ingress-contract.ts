/**
 * Public ingress — capability contract (adapter-first layer 1).
 *
 * "Public ingress" exposes one loopback-bound Kyberion surface (for example
 * the event-intake webhook receiver) at a public HTTPS URL through a tunnel
 * or reverse-proxy provider. Callers depend only on this contract; provider
 * identity lives in knowledge/product/governance/public-ingress-providers.json
 * and provider logic lives in libs/core/ingress/providers/*.
 *
 * Every provider is its own module implementing PublicIngressProvider; the
 * descriptor's `adapter` field is informational (it names the protocol
 * family), not a shared adapter implementation that providers plug into.
 *
 * Lifecycle scope (v1): `up` must leave the exposure running WITHOUT a
 * foreground process owned by Kyberion (Tailscale Funnel persists its config
 * in tailscaled). Providers that need a long-running foreground agent
 * (cloudflared, ngrok) require a managed-process lifecycle extension to this
 * contract (spawn via spawnManagedProcess, pid/health supervision, restart and
 * teardown on `down`) before their catalog entries can go live.
 *
 * Host-wide state: a provider's configuration usually outlives this checkout
 * (another worktree or a lost state file may have created it), so `down` and
 * `status` must inspect the provider, never trust local records alone, and
 * only ever act on a mapping whose target is exactly this surface's loopback
 * target (sameIngressTarget).
 *
 * See knowledge/product/governance/adapter-first-extension-policy.md.
 */

/** Readiness of one provider on this host. */
export type IngressReadinessStatus = 'ready' | 'needs_setup' | 'unsupported';

/** Where traffic reaching the exposure comes from (operator privacy note). */
export type IngressNetworkClass = 'public_internet' | 'tailnet_only' | 'local_only';

export interface IngressReadiness {
  status: IngressReadinessStatus;
  /** One concise, operator-facing reason (never contains secrets). */
  reason: string;
  /** Ordered setup actions when status is needs_setup. */
  setup_steps?: string[];
  network_class: IngressNetworkClass;
}

export interface IngressUpRequest {
  surfaceId: string;
  /** Loopback port the surface listens on. */
  localPort: number;
  /** Health path probed by the caller before exposing (informational for providers). */
  localHealthPath?: string;
  /** Public path the surface is mounted at; `/` when omitted. */
  pathPrefix?: string;
}

export interface IngressTargetRequest {
  surfaceId: string;
  pathPrefix?: string;
  /**
   * Loopback port the surface listens on. Together with the prefix it defines
   * the only target a provider may report as this surface's or remove.
   * Falls back to `exposure.local_port`; required when neither is given.
   */
  localPort?: number;
  /** The exposure previously recorded for this surface, when known. */
  exposure?: IngressExposure;
}

export interface IngressExposure {
  surface_id: string;
  provider_id: string;
  public_url: string;
  local_port: number;
  path_prefix: string;
  started_at: string;
  /** True when the URL survives restarts (webhook senders can keep it). */
  stable_url: boolean;
  pid?: number;
}

/** Provider adapter contract: one implementation per provider module. */
export interface PublicIngressProvider {
  readonly id: string;
  probe(): Promise<IngressReadiness>;
  up(request: IngressUpRequest): Promise<IngressExposure>;
  /**
   * Remove the mapping at the prefix only when it forwards to this surface's
   * loopback target; a missing mapping is a no-op; a foreign mapping fails
   * with INGRESS_COMMAND_FAILED; an uninspectable provider fails closed with
   * INGRESS_PROVIDER_NOT_READY.
   */
  down(request: IngressTargetRequest): Promise<void>;
  /**
   * The live exposure when the mapping at the prefix is public and forwards to
   * this surface's loopback target; undefined when absent or foreign. Throws
   * INGRESS_PROVIDER_NOT_READY when the provider cannot be inspected.
   */
  status(request: IngressTargetRequest): Promise<IngressExposure | undefined>;
}

/** Normalized error codes every provider and the resolver report with. */
export type IngressErrorCode =
  | 'INGRESS_INVALID_REQUEST'
  | 'INGRESS_PROVIDER_UNKNOWN'
  | 'INGRESS_PROVIDER_NOT_READY'
  | 'INGRESS_NO_READY_PROVIDER'
  | 'INGRESS_SURFACE_NOT_ALLOWED'
  | 'INGRESS_SURFACE_UNHEALTHY'
  | 'INGRESS_APPROVAL_REQUIRED'
  | 'INGRESS_COMMAND_FAILED'
  | 'INGRESS_NOT_EXPOSED';

export class IngressError extends Error {
  readonly code: IngressErrorCode;
  readonly providerId?: string;

  constructor(code: IngressErrorCode, message: string, providerId?: string) {
    super(`[${code}] ${message}`);
    this.name = 'IngressError';
    this.code = code;
    if (providerId) this.providerId = providerId;
  }
}

const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/**
 * Canonical path prefix: `/` or `/seg[/seg...]` with URL-safe segments and no
 * trailing slash. Rejects traversal, query strings and encoded characters so
 * a prefix can be passed to a provider CLI as a single argument.
 */
export function normalizeIngressPathPrefix(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/') return '/';
  if (!value.startsWith('/')) {
    throw new IngressError('INGRESS_INVALID_REQUEST', `path prefix must start with '/': ${value}`);
  }
  const segments = value.replace(/\/+$/u, '').split('/').slice(1);
  if (
    segments.length === 0 ||
    segments.some((segment) => !PATH_SEGMENT.test(segment) || /^\.+$/u.test(segment))
  ) {
    throw new IngressError('INGRESS_INVALID_REQUEST', `invalid path prefix: ${value}`);
  }
  return `/${segments.join('/')}`;
}

/** A surface port is an integer in 1..65535; providers always target 127.0.0.1. */
export function assertIngressLocalPort(port: unknown): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IngressError('INGRESS_INVALID_REQUEST', `invalid local port: ${String(port)}`);
  }
  return port;
}

/** Loopback target URL a provider forwards to (never a non-loopback host). */
export function ingressLoopbackTarget(port: number, pathPrefix: string): string {
  const prefix = normalizeIngressPathPrefix(pathPrefix);
  return `http://127.0.0.1:${assertIngressLocalPort(port)}${prefix === '/' ? '' : prefix}`;
}

/** The loopback port a down/status request is about (explicit or recorded). */
export function ingressRequestPort(request: IngressTargetRequest): number {
  const port = request.localPort ?? request.exposure?.local_port;
  if (port === undefined) {
    throw new IngressError(
      'INGRESS_INVALID_REQUEST',
      `no local port known for surface '${request.surfaceId}'; cannot identify its mapping`
    );
  }
  return assertIngressLocalPort(port);
}

function canonicalTarget(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    const host = ['localhost', '[::1]', '127.0.0.1'].includes(url.hostname)
      ? '127.0.0.1'
      : url.hostname.toLowerCase();
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const pathname = url.pathname.replace(/\/+$/u, '') || '/';
    return `${url.protocol}//${host}:${port}${pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a provider-reported proxy target is exactly `expected`, compared on
 * parsed scheme / host (loopback aliases folded) / port / path so harmless
 * normalisation (trailing slash, explicit default port, localhost) matches.
 * Unparseable or non-http targets never match.
 */
export function sameIngressTarget(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = canonicalTarget(actual);
  return left !== undefined && left === canonicalTarget(expected);
}

/** Join a public origin and a prefix: https://host + /events → https://host/events. */
export function joinIngressPublicUrl(origin: string, pathPrefix: string): string {
  const prefix = normalizeIngressPathPrefix(pathPrefix);
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') {
    throw new IngressError('INGRESS_INVALID_REQUEST', `public origin must be https: ${origin}`);
  }
  return `${parsed.origin}${prefix === '/' ? '' : prefix}`;
}
