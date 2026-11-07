import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

describeStoreGrantBoundary(
  'Identity resolver registration trusted import boundary',
  {
    implementation: 'libs/core/foundation/identity-context.ts',
    issuers: new Map([
      ['registerPolicyIdentityResolver', ['libs/core/identity-context-bridge.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/identity-context-bridge.ts',
        [
          'registerPolicyIdentityResolver',
          'readConfiguredActorIdentity',
          'resolvePolicyIdentityContext',
        ],
      ],
      ['libs/core/tier-guard.ts', ['resolvePolicyIdentityContext']],
      ['libs/core/voice/engine-runtime-preferences-access.ts', ['readConfiguredActorIdentity']],
    ]),
  },
  { privateModuleExportPath: './dist/foundation/identity-context.' }
);
