/**
 * Public ingress — capability contract (adapter-first layer 1).
 *
 * "Public ingress" exposes one loopback-bound Kyberion surface (for example
 * the event-intake webhook receiver) at a public HTTPS URL through a tunnel
 * or reverse-proxy provider. Callers depend only on this contract; provider
 * identity lives in knowledge/product/governance/public-ingress-providers.json
 * and provider logic lives in libs/core/ingress/providers/*.
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
  down(request: IngressTargetRequest): Promise<void>;
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

/** Join a public origin and a prefix: https://host + /events → https://host/events. */
export function joinIngressPublicUrl(origin: string, pathPrefix: string): string {
  const prefix = normalizeIngressPathPrefix(pathPrefix);
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') {
    throw new IngressError('INGRESS_INVALID_REQUEST', `public origin must be https: ${origin}`);
  }
  return `${parsed.origin}${prefix === '/' ? '' : prefix}`;
}
