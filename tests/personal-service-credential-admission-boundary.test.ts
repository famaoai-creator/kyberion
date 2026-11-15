import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary('Personal service opaque admission boundary', {
  implementation: 'libs/core/secret/personal-service-credential-admission.ts',
  issuers: new Map([
    [
      'withPersonalServiceCredentialAdmission',
      ['libs/core/secret/personal-service-credential-broker.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/secret/personal-service-credential-broker.ts',
      ['withPersonalServiceCredentialAdmission', 'resolvePersonalServiceCredentialAdmission'],
    ],
    [
      'libs/core/service/personal-service-engine-admission.ts',
      ['resolvePersonalServiceCredentialAdmission'],
    ],
  ]),
});
