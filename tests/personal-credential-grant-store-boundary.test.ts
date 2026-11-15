import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary('Personal credential canonical store adapter boundary', {
  implementation: 'libs/core/governance/personal-credential-grant-store.ts',
  issuers: new Map([
    ['writePersonalCredentialGrantRecord', ['libs/core/governance/personal-credential-grant.ts']],
    ['loadPersonalCredentialGrantRecord', ['libs/core/governance/personal-credential-grant.ts']],
    [
      'loadPersonalCredentialGrantRecordForRuntime',
      ['libs/core/governance/personal-credential-grant-runtime-reader.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/personal-credential-grant-runtime-reader.ts',
      ['loadPersonalCredentialGrantRecordForRuntime'],
    ],
    [
      'libs/core/governance/personal-credential-grant.ts',
      [
        'writePersonalCredentialGrantRecord',
        'loadPersonalCredentialGrantRecord',
        'newPersonalCredentialGrantId',
      ],
    ],
  ]),
});
