import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import type { CloudflareOsSurfaceAccess } from './cloudflare-os-surface.js';
import { isValidTenantSlug } from './entity-scope.js';
import { getRegisteredEnvText } from './foundation/env.js';

/**
 * SC-05: process-level shared control plane for the standard preflight /
 * post-op stages. Reads must see cross-process writes, so each access
 * catches the projection up to the journal tail — throttled so a listener
 * firing several times per op does not re-scan the journal every call.
 */
const REFRESH_MIN_INTERVAL_MS = 250;

let shared: CloudflareOsControlPlane | undefined;
let lastRefreshAt = 0;

export function sharedControlPlane(): CloudflareOsControlPlane {
  if (!shared) {
    shared = new CloudflareOsControlPlane();
    lastRefreshAt = Date.now();
    return shared;
  }
  const now = Date.now();
  if (now - lastRefreshAt >= REFRESH_MIN_INTERVAL_MS) {
    lastRefreshAt = now;
    shared.refreshFromJournals();
  }
  return shared;
}

export function resetSharedControlPlaneForTests(): void {
  shared = undefined;
  lastRefreshAt = 0;
}

/**
 * SC-08: the single facade through which callers obtain a control-plane
 * view. Direct `new CloudflareOsControlPlane()` outside this module is a
 * contract violation — the journal namespaces by tenant already, so one
 * process-level instance serves every scope while this entry point stays
 * the choke point for scope validation.
 *
 * Fail-closed: an explicit tenant slug must be valid; a tenantless scope
 * gets the same shared instance (records carry their own namespace).
 */
export function getControlPlaneForScope(scope?: { tenantSlug?: string }): CloudflareOsControlPlane {
  const tenant = scope?.tenantSlug?.trim();
  if (tenant && !isValidTenantSlug(tenant)) {
    throw new Error(`[POLICY_VIOLATION] Control-plane tenant scope is invalid: ${tenant}`);
  }
  return sharedControlPlane();
}

/**
 * SC-08: shared viewer→access resolution for the OS control-plane
 * surfaces. The common contract: `KYBERION_TENANT` narrows visibility,
 * the surface's principal env var must name a `human:` viewer when a
 * tenant is scoped, and an unscoped surface falls back to its local
 * default principal.
 */
export function resolveOsSurfaceAccess(input: {
  /** Env var naming the surface's human principal (e.g. KYBERION_MOS_PRINCIPAL). */
  principalEnv: string;
  /** Fallback principal when no tenant scope is configured. */
  defaultPrincipal: string;
  env?: NodeJS.ProcessEnv;
}): CloudflareOsSurfaceAccess {
  const env = input.env ?? process.env;
  const rawTenant = getRegisteredEnvText('KYBERION_TENANT', { env })?.trim() || '';
  const tenant = isValidTenantSlug(rawTenant) ? rawTenant : undefined;
  const configuredPrincipal = getRegisteredEnvText(input.principalEnv, { env })?.trim() || '';
  if (tenant && !configuredPrincipal) {
    throw new Error(
      `[POLICY_VIOLATION] ${input.principalEnv} is required for tenant-scoped OS projection`
    );
  }
  const principalId = configuredPrincipal || input.defaultPrincipal;
  if (!principalId.startsWith('human:')) {
    throw new Error(`[POLICY_VIOLATION] OS surface principal must identify a human viewer`);
  }
  return {
    principalId,
    tenantSlugs: tenant ? [tenant] : [],
  };
}
