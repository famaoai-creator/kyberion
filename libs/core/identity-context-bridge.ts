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
  const restoreSeam = identityContextResolverSeam.register('authority', next, metadata);
  const restoreResolver = registerPolicyIdentityResolver(next);
  return () => {
    restoreSeam();
    restoreResolver();
  };
}
