import type { Authority, IdentityContext } from './types.js';
import { getRegisteredEnvBool, getRegisteredEnvText } from './foundation/env.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';

export type IdentityContextResolver = (tenantOverride?: string) => IdentityContext;

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/identity-context-bridge.ts',
  reason: 'safe identity context bootstrap resolver',
};

const identityContextResolverSeam = createSeam<IdentityContextResolver>({
  key: 'identity-context-resolver',
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

const defaultResolver: IdentityContextResolver = (tenantOverride) => {
  const envPersona = getRegisteredEnvText('KYBERION_PERSONA');
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
    missionId: getRegisteredEnvText('MISSION_ID'),
    role: getRegisteredEnvText('MISSION_ROLE'),
    tenantSlug: tenantOverride || getRegisteredEnvText('KYBERION_TENANT'),
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
