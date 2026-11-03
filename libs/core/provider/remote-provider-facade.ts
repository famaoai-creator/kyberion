/**
 * remote-provider facade — turns a transport + remote provider id into an
 * object with the capability's method shape, so a seam can register
 * `ocr:remote-x` and `ProviderChainRouter` call sites invoke it exactly like
 * an in-process provider.
 *
 * Each declared operation forwards a canonical `TransportInvocation` through
 * the resolved transport and unwraps the envelope — failed envelopes throw
 * `ProviderTransportError` with the remote's stable `code` preserved.
 */

import {
  ProviderTransportError,
  resolveProviderTransport,
  type ProviderTransport,
} from '../provider-transport.js';

export interface RemoteProviderFacadeOptions {
  /** Named capability seam the remote side resolves, e.g. 'ocr-provider'. */
  seam: string;
  /** Provider id inside that seam on the remote side. */
  provider: string;
  /** Operations (method names) exposed on the facade. */
  operations: readonly string[];
  /** Transport selector or instance; defaults to the governed resolution. */
  transport?: string | ProviderTransport;
  /** Default deadline forwarded as `invocation.timeoutMs`. */
  timeoutMs?: number;
}

export function createRemoteProviderFacade<TProvider extends object>(
  options: RemoteProviderFacadeOptions
): TProvider {
  const transport =
    typeof options.transport === 'string'
      ? resolveProviderTransport(options.transport)
      : (options.transport ?? resolveProviderTransport());
  const context = `${options.seam}/${options.provider}`;
  const facade: Record<string, unknown> = { id: options.provider };
  for (const operation of options.operations) {
    facade[operation] = async (...args: readonly unknown[]) => {
      const result = await transport.invoke({
        seam: options.seam,
        provider: options.provider,
        operation,
        args,
        timeoutMs: options.timeoutMs,
      });
      if (result.ok === false) throw new ProviderTransportError(result.error, context);
      return result.result;
    };
  }
  return facade as TProvider;
}
