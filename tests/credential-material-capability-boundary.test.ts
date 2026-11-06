import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the allocated credential material grant is module-private (an opaque
// issuer grant). Only the credential allocation broker issues it; tier-guard and
// authority.ts ask the pure predicate while the dedicated reader role still exists.
describeStoreGrantBoundary('Credential material grant trusted import boundary', {
  implementation: 'libs/core/foundation/credential-material-capability.ts',
  issuers: new Map([
    ['withCredentialMaterialCapability', ['libs/core/secret/credential-allocations.ts']],
  ]),
  consumers: new Map([
    ['libs/core/secret/credential-allocations.ts', ['withCredentialMaterialCapability']],
    ['libs/core/tier-guard.ts', ['isCredentialMaterialCapability']],
    ['libs/core/authority.ts', ['isCredentialMaterialCapability']],
  ]),
});
