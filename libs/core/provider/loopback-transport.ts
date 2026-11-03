/**
 * loopback provider transport — the governed default.
 *
 * Resolves the target provider on `coreSeamCatalog` and invokes the operation
 * in-process. Zero serialization, zero network — remote transports plug into
 * the same seam and envelope, so callers and capability adapters never learn
 * whether a provider was local or remote.
 *
 * Importing this module installs `loopback` on the provider-transport seam.
 */

import { coreSeamCatalog, type Seam } from '../seam.js';
import {
  LOOPBACK_TRANSPORT_ID,
  PROVIDER_TRANSPORT_SEAM,
  registerProviderTransport,
  type ProviderTransport,
  type TransportErrorPayload,
  type TransportInvocation,
  type TransportResult,
} from '../provider-transport.js';

type CallableProvider = Record<string, unknown>;

function failure(code: string, message: string, retryable = false): TransportResult {
  const error: TransportErrorPayload = { code, message, retryable };
  return { ok: false, error };
}

function resolveTarget(
  invocation: TransportInvocation
): { provider: CallableProvider } | TransportResult {
  const seam = coreSeamCatalog.get<CallableProvider>(invocation.seam) as
    Seam<CallableProvider> | undefined;
  if (!seam)
    return failure(
      'SEAM_NOT_FOUND',
      `no seam registered under key '${invocation.seam}' (checked ${PROVIDER_TRANSPORT_SEAM} catalog)`
    );
  const provider = seam.getOptional(invocation.provider);
  if (!provider)
    return failure(
      'PROVIDER_NOT_FOUND',
      `no provider '${invocation.provider}' registered on seam '${invocation.seam}'`
    );
  return { provider };
}

function toErrorPayload(error: unknown): TransportErrorPayload {
  const message = error instanceof Error ? error.message : String(error);
  // Errors already tagged [SOME_CODE] keep the tag as the stable code.
  const tagged = /^\[([A-Z][A-Z0-9_]+)\]/.exec(message);
  return { code: tagged ? tagged[1] : 'PROVIDER_ERROR', message, retryable: false };
}

export const loopbackTransport: ProviderTransport = {
  id: LOOPBACK_TRANSPORT_ID,
  async invoke(invocation: TransportInvocation): Promise<TransportResult> {
    const target = resolveTarget(invocation);
    if ('ok' in target) return target;
    const operation = target.provider[invocation.operation];
    if (typeof operation !== 'function')
      return failure(
        'OPERATION_NOT_FOUND',
        `provider '${invocation.provider}' on seam '${invocation.seam}' has no callable operation '${invocation.operation}'`
      );
    try {
      const result = await (operation as (...args: readonly unknown[]) => unknown).apply(
        target.provider,
        invocation.args as unknown[]
      );
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: toErrorPayload(error) };
    }
  },
  async health() {
    return { ok: true };
  },
};

registerProviderTransport(loopbackTransport, {
  provenance: 'builtin',
  source: 'libs/core/provider/loopback-transport.ts',
});
