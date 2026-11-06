import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the customer decision milestone grant is module-private. Only the mission
// bolt review issues it; tier-guard, authority.ts and the content rules ask the
// pure predicates while the dedicated role still exists.
describeStoreGrantBoundary('Customer decision milestone grant trusted import boundary', {
  implementation: 'libs/core/foundation/customer-decision-milestone-capability.ts',
  issuers: new Map([
    ['withCustomerDecisionMilestoneCapability', ['libs/core/mission/mission-bolt-review.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/mission/mission-bolt-review.ts',
      ['CUSTOMER_DECISION_MILESTONE_STORE_ROLE', 'withCustomerDecisionMilestoneCapability'],
    ],
    ['libs/core/customer-decision/store.ts', ['CUSTOMER_DECISION_MILESTONE_STORE_ROLE']],
    [
      'libs/core/tier-guard.ts',
      ['isCustomerDecisionMilestoneCapability', 'CUSTOMER_DECISION_MILESTONE_STORE_ROLE'],
    ],
    [
      'libs/core/authority.ts',
      ['isCustomerDecisionMilestoneCapability', 'CUSTOMER_DECISION_MILESTONE_STORE_ROLE'],
    ],
    [
      'libs/core/foundation/customer-decision-write-content.ts',
      ['CUSTOMER_DECISION_MILESTONE_STORE_ROLE', 'customerDecisionMilestoneWriteProblem'],
    ],
    ['libs/core/foundation/customer-decision-consumer-capability.ts', ['caseRecordCanonicalJson']],
    ['libs/core/foundation/customer-decision-invite-write-content.ts', ['caseRecordCanonicalJson']],
  ]),
});
