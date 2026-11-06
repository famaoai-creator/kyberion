import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the allocated credential material grant is module-private (an opaque
// issuer grant) and is itself the authority. Only the credential allocation
// broker issues it; the tier-guard store-grant table asks the authority
// predicate. authority.ts and tier-guard.ts no longer import it (the role is gone).
describeStoreGrantBoundary(
  'Credential material grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/credential-material-capability.ts',
    issuers: new Map([
      ['withCredentialMaterialCapability', ['libs/core/secret/credential-allocations.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/secret/credential-allocations.ts',
        ['withCredentialMaterialCapability', 'CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT'],
      ],
    ]),
  },
  {
    formerConsumers: [
      'libs/core/tier-guard.ts',
      'libs/core/authority.ts',
      'libs/core/tier-guard-store-grants.ts',
    ],
  }
);
