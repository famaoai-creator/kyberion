import { getRegisteredEnvText } from '../foundation/env.js';
import { loadSurfaceManifest, type SurfaceRuntimeDefinition } from './surface-runtime.js';

/**
 * RS-04: the surface manifest (knowledge/product/governance/surfaces/*.json,
 * mirrored in active-surfaces.json) is the single registry of surface ports.
 * Callers resolve a surface URL here instead of hardcoding 127.0.0.1:<port>.
 */
export function findSurfaceDefinition(surfaceId: string): SurfaceRuntimeDefinition | undefined {
  return loadSurfaceManifest().surfaces.find((surface) => surface.id === surfaceId);
}

/** Registered port for a surface id; throws (fail closed) when unregistered or portless. */
export function resolveSurfacePort(surfaceId: string): number {
  const definition = findSurfaceDefinition(surfaceId);
  if (!definition || typeof definition.port !== 'number' || definition.port <= 0) {
    throw new Error(
      `[SURFACE_REGISTRY] Surface "${surfaceId}" has no registered port in the surface manifest. ` +
        `Register it under knowledge/product/governance/surfaces/${surfaceId}.json (port).`
    );
  }
  return definition.port;
}

/**
 * Base URL (no trailing slash) for a surface. The surface's declared `urlEnv`
 * override wins when set; otherwise http://127.0.0.1:<registered port>.
 */
export function resolveSurfaceUrl(surfaceId: string): string {
  const definition = findSurfaceDefinition(surfaceId);
  const envName = definition?.urlEnv;
  const override = envName ? getRegisteredEnvText(envName) : undefined;
  const base = override || `http://127.0.0.1:${resolveSurfacePort(surfaceId)}`;
  return String(base).replace(/\/+$/u, '');
}

/** Browser navigation follows the already-declared public origin contract.
 * Keep runtime service calls on resolveSurfaceUrl: public proxies do not change
 * listeners, trust-proxy policy, cookies or action authorization. */
export function resolveSurfaceBrowserUrl(surfaceId: string): string {
  const entries = (getRegisteredEnvText('KYBERION_OIDC_PUBLIC_BASE_URLS') ?? '').split(',');
  const named = entries
    .map((entry) => {
      const split = entry.indexOf('=');
      return split < 0 ? null : [entry.slice(0, split).trim(), entry.slice(split + 1).trim()];
    })
    .filter((entry): entry is string[] => entry !== null)
    .find((entry) => entry[0] === surfaceId)?.[1];
  const declared = named || getRegisteredEnvText('KYBERION_OIDC_PUBLIC_BASE_URL');
  if (declared) {
    const url = new URL(declared);
    const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    )
      throw new Error('[SURFACE_PUBLIC_ORIGIN] Invalid public surface origin');
    return url.origin;
  }
  const base = resolveSurfaceUrl(surfaceId);
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('[SURFACE_URL] Invalid browser surface URL');
  return base;
}
