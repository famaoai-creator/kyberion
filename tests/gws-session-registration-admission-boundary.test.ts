import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary('GWS session registration admission', {
  implementation: 'libs/core/foundation/gws-session-registration-admission.ts',
  issuers: new Map([
    ['withGwsSessionRegistrationAdmission', ['libs/core/secret/account-introduction.ts']],
  ]),
  consumers: new Map([
    ['libs/core/secret/account-introduction.ts', ['withGwsSessionRegistrationAdmission']],
    ['libs/core/secret/gws-session-store.ts', ['assertGwsSessionRegistrationAdmission']],
  ]),
});

describeStoreGrantBoundary('GWS session operator storage facade', {
  implementation: 'libs/core/secret/gws-session-store.ts',
  issuers: new Map([
    ['prepareGwsSessionRegistration', ['libs/core/secret/account-introduction.ts']],
    ['commitGwsSessionRegistration', ['libs/core/secret/account-introduction.ts']],
    ['abortGwsSessionRegistration', ['libs/core/secret/account-introduction.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/secret/account-introduction.ts',
      [
        'loadGwsSessionRegistration',
        'prepareGwsSessionRegistration',
        'commitGwsSessionRegistration',
        'abortGwsSessionRegistration',
      ],
    ],
  ]),
});
