import type { A2AMessage } from './a2a-bridge.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type A2ARoute = (envelope: A2AMessage) => Promise<A2AMessage>;

const a2aRouteSeam = createSeam<A2ARoute>({
  key: 'a2a-route',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/a2a-route-port.ts',
  reason: 'canonical A2A route registration',
};

export function registerA2ARoute(
  route: A2ARoute,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  const registeredRoute = a2aRouteSeam.getOptional();
  if (registeredRoute && registeredRoute !== route) {
    throw new Error('[A2A_ROUTE_ALREADY_REGISTERED] refusing to replace the canonical route');
  }
  if (registeredRoute === route) return () => undefined;
  return a2aRouteSeam.register('canonical', route, metadata);
}

export function getA2ARoute(): A2ARoute | undefined {
  return a2aRouteSeam.getOptional();
}
