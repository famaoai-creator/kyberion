import {
  CloudflareOsControlPlane,
  CloudflareOsReadOnlySurface,
  CloudflareOsSurface,
  auditChain,
  type CloudflareOsSurfaceAccess,
  type CloudflareOsSurfaceSnapshot,
  isValidTenantSlug,
} from '@agent/core';

export function getComputerSurfaceAccess(
  env: NodeJS.ProcessEnv = process.env
): CloudflareOsSurfaceAccess {
  const rawTenant = String(env.KYBERION_TENANT || '').trim();
  const tenant = isValidTenantSlug(rawTenant) ? rawTenant : undefined;
  const configuredPrincipal = String(env.KYBERION_COMPUTER_SURFACE_PRINCIPAL || '').trim();
  if (tenant && !configuredPrincipal) {
    throw new Error(
      '[POLICY_VIOLATION] KYBERION_COMPUTER_SURFACE_PRINCIPAL is required for tenant-scoped OS projection'
    );
  }
  const principalId = configuredPrincipal || 'human:computer-surface-localadmin';
  if (!principalId.startsWith('human:')) {
    throw new Error(
      '[POLICY_VIOLATION] Computer Surface OS principal must identify a human viewer'
    );
  }
  return {
    principalId,
    tenantSlugs: tenant ? [tenant] : [],
  };
}

export function getComputerSurfaceTenantScope(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const rawTenant = String(env.KYBERION_TENANT || '').trim();
  return isValidTenantSlug(rawTenant) ? rawTenant : undefined;
}

export function getComputerSurfaceGuardedSurfaceUrl(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configured = String(env.KYBERION_OS_GUARDED_SURFACE_URL || '').trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const readOnlySurface = new CloudflareOsReadOnlySurface(
  new CloudflareOsSurface(new CloudflareOsControlPlane({ auditRestoreFailures: false }))
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
