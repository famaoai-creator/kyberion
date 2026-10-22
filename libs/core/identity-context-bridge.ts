import type { Authority, IdentityContext } from './types.js';
import { getRegisteredEnvBool, getRegisteredEnvText } from './foundation/env.js';
import { resolveProjectScope } from './foundation/project-scope-env.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
import { scopedAssumedRole, scopedPersona } from './foundation/execution-scope.js';

export type IdentityContextResolver = (tenantOverride?: string) => IdentityContext;

export interface ConfiguredActorIdentity {
  persona?: string;
  role?: string;
}

/** Read process-configured identity at an explicit boundary, independent of scoped overrides. */
export function readConfiguredActorIdentity(
  env: Record<string, string | undefined> = process.env
): ConfiguredActorIdentity {
  return {
    persona: getRegisteredEnvText('KYBERION_PERSONA', { env }),
    role: getRegisteredEnvText('MISSION_ROLE', { env }),
  };
}

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/identity-context-bridge.ts',
  reason: 'safe identity context bootstrap resolver',
};

const identityContextResolverSeam = createSeam<IdentityContextResolver>({
  key: 'identity-context-resolver',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
  owner: 'libs/core/identity-context-bridge.ts',
});

const defaultResolver: IdentityContextResolver = (tenantOverride) => {
  // RA-01: an in-process withExecutionContext* assumption outranks the env.
  const scoped = scopedPersona();
  const projectScope = resolveProjectScope();
  const configured = readConfiguredActorIdentity();
  const envPersona = scoped.bound ? scoped.persona : configured.persona;
  const persona =
    envPersona === 'sovereign' ||
    envPersona === 'ecosystem_architect' ||
    envPersona === 'mission_owner' ||
    envPersona === 'worker' ||
    envPersona === 'analyst'
      ? envPersona
      : 'unknown';
  const authorities: Authority[] =
    persona === 'sovereign' || persona === 'ecosystem_architect'
      ? ['GIT_WRITE', 'SECRET_READ', 'NETWORK_FETCH', 'SYSTEM_EXEC', 'KNOWLEDGE_WRITE']
      : [];
  if (getRegisteredEnvBool('KYBERION_SUDO')) authorities.push('SUDO');
  return {
    persona,
    executionMode:
      persona === 'sovereign'
        ? 'sovereign'
        : persona === 'ecosystem_architect'
          ? 'system'
          : 'mission',
    authorities,
    missionId: projectScope.missionId,
    role: scopedAssumedRole() || configured.role,
    tenantSlug: tenantOverride || projectScope.tenantSlug,
  };
};

export function registerIdentityContextResolver(
  next: IdentityContextResolver,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return identityContextResolverSeam.register('authority', next, metadata);
}

/**
 * Tier policy needs identity synchronously, including during secure-io
 * bootstrap. Keep that low-level dependency pointed at a safe default until
 * authority has installed its complete resolver; this avoids making the
 * policy layer import the higher-level authority module.
 */
export function resolvePolicyIdentityContext(tenantOverride?: string): IdentityContext {
  return (identityContextResolverSeam.getOptional() ?? defaultResolver)(tenantOverride);
}
