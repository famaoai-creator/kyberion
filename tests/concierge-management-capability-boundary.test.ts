import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the Concierge management grant is module-private. Only the governed facade
// surface/concierge-management-access.ts opens it (synchronous or for the
// lifetime of one awaited body); the project surface mutation guard and the
// information asset coverage read ask the pure predicate instead of a role name.
describeStoreGrantBoundary(
  'Concierge management grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/concierge-management-capability.ts',
    issuers: new Map([
      ['withConciergeManagementGrant', ['libs/core/surface/concierge-management-access.ts']],
      ['withConciergeManagementGrantAsync', ['libs/core/surface/concierge-management-access.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/surface/concierge-management-access.ts',
        [
          'CONCIERGE_MANAGEMENT_ISSUANCE_RIGHTS',
          'withConciergeManagementGrant',
          'withConciergeManagementGrantAsync',
        ],
      ],
      ['libs/core/project/project-management.ts', ['conciergeManagementGrantKind']],
    ]),
  },
  { formerConsumers: ['libs/core/foundation/information-asset-coverage-capability.ts'] }
);

// The Web management mediators open their exact request ceiling only through the facade.
describeStoreGrantBoundary('Concierge management access facade trusted import boundary', {
  implementation: 'libs/core/surface/concierge-management-access.ts',
  issuers: new Map([
    [
      'withConciergeManagementAccess',
      [
        'libs/core/information-assets/access.ts',
        'libs/core/organization/organization-people-access.ts',
      ],
    ],
    ['withConciergeManagementAccessAsync', ['libs/core/surface/surface-management-mutations.ts']],
  ]),
  consumers: new Map([
    ['libs/core/information-assets/access.ts', ['withConciergeManagementAccess']],
    ['libs/core/organization/organization-people-access.ts', ['withConciergeManagementAccess']],
    ['libs/core/surface/surface-management-mutations.ts', ['withConciergeManagementAccessAsync']],
  ]),
});
