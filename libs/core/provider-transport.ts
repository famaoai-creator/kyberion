/**
 * provider-transport seam — Layer-3 of the distributed-runtime architecture.
 *
 * Every named capability seam (ocr-provider, image-generation, lease-backend,
 * …) registers providers as in-process objects. This seam is the transport
 * beneath them: a `ProviderTransport` takes a canonical invocation envelope —
 * target seam, target provider, operation name, JSON-serializable args — and
 * returns a result envelope. The governed default is `loopback`, which
 * resolves the provider on `coreSeamCatalog` and calls it in-process, so
 * existing call sites pay zero serialization cost and keep local_first.
 *
 * Remote transports (http/grpc/worker-rpc) register on the same seam and are
 * selected through governed `default_chains`, never through call-site
 * conditionals — same selection order as the storage/lease seams:
 * explicit selector → governed default chain → `loopback` → first registered.
 *
 * Remote transports carry the boundary invariants declared in
 * `seam-provider-selection/provider-transport.json` (tenant-aware, no
 * serialized credentials — secrets travel by reference through
 * secret-resolver only, governed timeouts/retries). Capability adapters that
 * want remote execution wrap their provider with
 * `createRemoteProviderFacade` (`libs/core/provider/remote-provider-facade.ts`).
 */

import { createProviderRegistry, type ProviderRegistry } from './provider-registry.js';
import { resolveSeamDefaultOrder } from './seam-provider-selection.js';
import type { SeamProviderMetadata } from './seam.js';

export const PROVIDER_TRANSPORT_SEAM = 'provider-transport';
export const LOOPBACK_TRANSPORT_ID = 'loopback';

/** Canonical cross-boundary invocation envelope. */
export interface TransportInvocation {
  /** Named capability seam whose provider handles the call, e.g. 'ocr-provider'. */
  seam: string;
  /** Provider id inside that seam (remote side resolves it identically). */
  provider: string;
  /** Operation (method name) to invoke on the provider. */
  operation: string;
  /** Positional arguments; must be JSON-serializable for remote transports. */
  args: readonly unknown[];
  /** Caller-requested deadline; remote transports enforce, loopback ignores. */
  timeoutMs?: number;
}

/** Stable error payload remote transports must map to. */
export interface TransportErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

export type TransportResult =
  { ok: true; result: unknown } | { ok: false; error: TransportErrorPayload };

export interface TransportHealth {
  ok: boolean;
  detail?: string;
}

export interface ProviderTransport {
  readonly id: string;
  /** Execute one invocation; errors come back in the envelope, never thrown raw. */
  invoke(invocation: TransportInvocation): Promise<TransportResult>;
  /** Optional liveness probe (remote transports implement; loopback is trivially healthy). */
  health?(provider?: string): Promise<TransportHealth>;
}

/** Error thrown when a facade unwraps a failed `TransportResult`. */
export class ProviderTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(payload: TransportErrorPayload, context: string) {
    super(`${context}: ${payload.code}: ${payload.message}`);
    this.name = 'ProviderTransportError';
    this.code = payload.code;
    this.retryable = payload.retryable ?? false;
  }
}

const registry: ProviderRegistry<ProviderTransport> = createProviderRegistry<ProviderTransport>({
  seam: PROVIDER_TRANSPORT_SEAM,
  owner: 'libs/core/provider-transport.ts',
  source: 'libs/core/provider-transport.ts',
  missingIdError: 'provider transport requires an id',
});

export function registerProviderTransport(
  transport: ProviderTransport,
  metadata?: SeamProviderMetadata
): () => void {
  return registry.register(transport, metadata);
}

export function listProviderTransports(): readonly ProviderTransport[] {
  return registry.list();
}

export function getProviderTransport(id: string): ProviderTransport | undefined {
  return registry.get(id);
}

/**
 * First registered transport of the default order: saved seam default
 * (`KYBERION_SEAM_DEFAULTS` / scope layers) → governed `default_chains.default`.
 */
function governedDefault(): ProviderTransport | undefined {
  const chain = resolveSeamDefaultOrder(PROVIDER_TRANSPORT_SEAM);
  for (const id of chain) {
    const transport = registry.get(id);
    if (transport) return transport;
  }
  return undefined;
}

/**
 * Resolve the transport for an invocation. Order:
 * explicit selector → saved seam default → governed `default_chains.default` →
 * `loopback` → first registered. An explicit selector that resolves to nothing throws —
 * silent fallback would hide a mis-pinned provider.
 */
export function resolveProviderTransport(selector?: string): ProviderTransport {
  if (selector !== undefined) {
    const selected = registry.get(selector);
    if (!selected)
      throw new Error(
        `[PROVIDER_TRANSPORT] unknown transport '${selector}' for seam ${PROVIDER_TRANSPORT_SEAM}`
      );
    return selected;
  }
  const governed = governedDefault();
  if (governed) return governed;
  const loopback = registry.get(LOOPBACK_TRANSPORT_ID);
  if (loopback) return loopback;
  const [first] = registry.list();
  if (!first)
    throw new Error(
      `[PROVIDER_TRANSPORT] no transport registered for seam ${PROVIDER_TRANSPORT_SEAM}`
    );
  return first;
}
