import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary('Asset derivation receipt query trusted import boundary', {
  implementation: 'libs/core/information-assets/asset-derivation-read-capability.ts',
  issuers: new Map([
    ['withAssetDerivationReceiptSnapshot', ['libs/core/information-assets/asset-derivation.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/information-assets/asset-derivation.ts',
      ['withAssetDerivationReceiptSnapshot', 'currentAssetDerivationReceiptSnapshot'],
    ],
  ]),
});
