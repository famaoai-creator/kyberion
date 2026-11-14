import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';
describeStoreGrantBoundary('Personal credential use authority import boundary', {
  implementation: 'libs/core/foundation/personal-credential-use-capability.ts',
  issuers: new Map([
    [
      'withPersonalCredentialUseCapability',
      ['libs/core/secret/personal-service-credential-broker.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/secret/personal-service-credential-broker.ts',
      ['withPersonalCredentialUseCapability', 'PersonalCredentialUseAdmission'],
    ],
    [
      'libs/core/governance/personal-credential-grant-runtime-reader.ts',
      ['assertPersonalCredentialUseRead'],
    ],
    ['libs/core/secret/secret-guard.ts', ['assertPersonalCredentialUseRead']],
    [
      'libs/core/governance/personal-credential-grant-store.ts',
      ['assertPersonalCredentialUseRead'],
    ],
  ]),
});
