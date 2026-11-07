import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G3: tier-guard asks live store grants through one registry instead of importing every
// capability module. Registering is the sensitive act (a registered rule is consulted by the
// guard), so only the grant modules themselves may name `registerStoreGrant`, and each of
// them registers exactly the one id it owns. The guard, the narrow store denial and the
// coverage rule only read.
const registrants = [
  'libs/core/foundation/autonomy-learning-capability.ts',
  'libs/core/foundation/concierge-management-capability.ts',
  'libs/core/foundation/credential-material-capability.ts',
  'libs/core/foundation/customer-decision-consumer-capability.ts',
  'libs/core/foundation/customer-decision-invite-capability.ts',
  'libs/core/foundation/customer-decision-milestone-capability.ts',
  'libs/core/foundation/discussion-request-capability.ts',
  'libs/core/foundation/dot-result-store-capability.ts',
  'libs/core/foundation/personal-approval-io-capability.ts',
  'libs/core/foundation/pipeline-journal-capability.ts',
  'libs/core/foundation/pr-publication-store-capability.ts',
  'libs/core/foundation/task-source-workspace-capability.ts',
  'libs/core/governance/person-charter-runtime.ts',
  'libs/core/knowledge/memory-provenance-capability.ts',
];

describeStoreGrantBoundary(
  'Store grant registry trusted import boundary',
  {
    implementation: 'libs/core/foundation/store-grant-registry.ts',
    issuers: new Map([['registerStoreGrant', registrants]]),
    consumers: new Map<string, readonly string[]>([
      ...registrants.map((file) => [file, ['registerStoreGrant']] as const),
      [
        'libs/core/foundation/customer-decision-milestone-capability.ts',
        ['registerStoreGrant', 'storeGrantActive'],
      ],
      [
        'libs/core/tier-guard.ts',
        ['storeGrantAuthorizes', 'storeGrantNarrowingDenial', 'storeGrantRule', 'storeGrantRules'],
      ],
      ['libs/core/foundation/information-asset-coverage-access.ts', ['storeGrantRule']],
    ]),
  },
  { formerConsumers: ['libs/core/authority.ts'] }
);
