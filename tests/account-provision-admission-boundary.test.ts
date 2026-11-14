import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary('Account provisioning trusted import boundary', {
  implementation: 'libs/core/foundation/account-provision-admission.ts',
  issuers: new Map([
    ['withAccountProvisionAdmission', ['libs/core/secret/account-introduction.ts']],
    ['withAccountProvisionRequest', ['libs/core/secret/account-broker.ts']],
  ]),
  consumers: new Map([
    ['libs/core/secret/account-introduction.ts', ['withAccountProvisionAdmission']],
    [
      'libs/core/secret/account-broker.ts',
      ['assertAccountIntroductionProvisioning', 'withAccountProvisionRequest'],
    ],
    ['libs/core/secret/secret-resolver.ts', ['assertAccountProvisionRequest']],
  ]),
});
