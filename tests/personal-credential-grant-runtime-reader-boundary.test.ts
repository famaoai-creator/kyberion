import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';
describeStoreGrantBoundary('Personal consent runtime read adapter boundary', {
  implementation: 'libs/core/governance/personal-credential-grant-runtime-reader.ts',
  issuers: new Map([
    [
      'loadPersonalRuntimeCredentialGrant',
      ['libs/core/secret/personal-service-credential-broker.ts'],
    ],
    [
      'loadPersonalRuntimeCredentialApproval',
      ['libs/core/secret/personal-service-credential-broker.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/secret/personal-service-credential-broker.ts',
      [
        'loadPersonalRuntimeCredentialGrant',
        'loadPersonalRuntimeCredentialApproval',
        'personalCredentialApprovalPath',
      ],
    ],
  ]),
});
