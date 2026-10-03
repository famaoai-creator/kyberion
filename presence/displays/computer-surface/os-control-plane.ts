import { getControlPlaneForScope, resolveOsSurfaceAccess } from '@agent/core/cloudflare-os-shared';
import {
  CloudflareOsReadOnlySurface,
  CloudflareOsSurface,
  type CloudflareOsSurfaceAccess,
  type CloudflareOsSurfaceSnapshot,
} from '@agent/core/cloudflare-os-surface';
import { auditChain } from '@agent/core/governance/audit-chain';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import { getRegisteredEnvText } from '@agent/core/foundation';

export function getComputerSurfaceAccess(
  env: NodeJS.ProcessEnv = process.env
): CloudflareOsSurfaceAccess {
  return resolveOsSurfaceAccess({
    principalEnv: 'KYBERION_COMPUTER_SURFACE_PRINCIPAL',
    defaultPrincipal: 'human:computer-surface-localadmin',
    env,
  });
}

export function getComputerSurfaceTenantScope(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const rawTenant = getRegisteredEnvText('KYBERION_TENANT', { env })?.trim() || '';
  return isValidTenantSlug(rawTenant) ? rawTenant : undefined;
}

export function getComputerSurfaceGuardedSurfaceUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configured = getRegisteredEnvText('KYBERION_OS_GUARDED_SURFACE_URL', { env })?.trim() || '';
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const readOnlySurface = new CloudflareOsReadOnlySurface(
  new CloudflareOsSurface(getControlPlaneForScope())
);

export function getComputerSurfaceOsSnapshot(
  missionId: string | undefined,
  surface: Pick<CloudflareOsReadOnlySurface, 'snapshot'> = readOnlySurface,
  access: CloudflareOsSurfaceAccess = getComputerSurfaceAccess()
): CloudflareOsSurfaceSnapshot {
  return surface.snapshot(missionId, access);
}

export function recordComputerSurfaceRead(
  access: CloudflareOsSurfaceAccess,
  snapshot: CloudflareOsSurfaceSnapshot,
  record: (entry: Parameters<typeof auditChain.record>[0]) => unknown = (entry) =>
    auditChain.record(entry)
): void {
  const tenantScope = access.tenantSlugs === 'all' ? 'all' : [...access.tenantSlugs];
  record({
    agentId: 'computer-surface',
    action: 'computer_surface.read',
    operation: 'os_control_plane',
    result: 'completed',
    ...(tenantScope.length === 1 && tenantScope[0] ? { tenantSlug: tenantScope[0] } : {}),
    metadata: {
      principal_id: access.principalId,
      tenant_scope: tenantScope,
      ...(snapshot.missionId ? { mission_id: snapshot.missionId } : {}),
      held_action_count: snapshot.heldActions.length,
      observation_count: snapshot.observations.length,
    },
  });
}
