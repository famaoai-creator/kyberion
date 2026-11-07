import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from './seam.js';
import {
  readConfiguredActorIdentity,
  registerPolicyIdentityResolver,
  resolvePolicyIdentityContext,
  type ConfiguredActorIdentity,
  type IdentityContextResolver,
} from './foundation/identity-context.js';

export {
  readConfiguredActorIdentity,
  resolvePolicyIdentityContext,
  type ConfiguredActorIdentity,
  type IdentityContextResolver,
};

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

export function registerIdentityContextResolver(
  next: IdentityContextResolver,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  const restoreResolver = registerPolicyIdentityResolver(next);
  let restoreSeam: () => void;
  try {
    restoreSeam = identityContextResolverSeam.register('authority', next, metadata);
  } catch (error) {
    restoreResolver();
    throw error;
  }
  return () => {
    try {
      restoreSeam();
    } finally {
      restoreResolver();
    }
  };
}
