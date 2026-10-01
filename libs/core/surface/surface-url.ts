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
