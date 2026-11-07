import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the customer decision milestone grant is module-private and is itself the
// authority. Only the mission bolt review issues it; the store-grant table asks
// the authority predicate, and the narrow store denial and the agenda store apply
// the CD-10 milestone-only rule inside a live grant. tier-guard and authority.ts
// no longer import it.
describeStoreGrantBoundary(
  'Customer decision milestone grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/customer-decision-milestone-capability.ts',
    issuers: new Map([
      ['withCustomerDecisionMilestoneCapability', ['libs/core/mission/mission-bolt-review.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/mission/mission-bolt-review.ts',
        [
          'CUSTOMER_DECISION_MILESTONE_GRANT_ISSUANCE_RIGHT',
          'withCustomerDecisionMilestoneCapability',
        ],
      ],
      ['libs/core/customer-decision/store.ts', ['customerDecisionMilestoneGrantActive']],
      [
        'libs/core/foundation/customer-decision-consumer-capability.ts',
        ['caseRecordCanonicalJson'],
      ],
      [
        'libs/core/foundation/customer-decision-invite-write-content.ts',
        ['caseRecordCanonicalJson'],
      ],
    ]),
  },
  {
    formerConsumers: [
      'libs/core/tier-guard.ts',
      'libs/core/authority.ts',
      'libs/core/tier-guard-store-grants.ts',
      'libs/core/foundation/narrow-store-role-denial.ts',
    ],
  }
);
