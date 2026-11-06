import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the customer decision consumer-lock grant is module-private. Only the
// mission decision lock and the operator re-ask facade issue it; tier-guard,
// authority.ts and the content rules ask the pure predicates while the
// dedicated role still exists.
describeStoreGrantBoundary('Customer decision consumer grant trusted import boundary', {
  implementation: 'libs/core/foundation/customer-decision-consumer-capability.ts',
  issuers: new Map([
    [
      'withCustomerDecisionConsumerCapability',
      ['libs/core/mission/mission-decision-lock.ts', 'libs/core/customer-decision/store.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/mission/mission-decision-lock.ts',
      [
        'CUSTOMER_DECISION_CONSUMER_STORE_ROLE',
        'customerDecisionsRootDir',
        'runInCustomerDecisionConsumerSweep',
        'withCustomerDecisionConsumerCapability',
      ],
    ],
    [
      'libs/core/customer-decision/store.ts',
      [
        'CUSTOMER_DECISION_CONSUMER_STORE_ROLE',
        'withCustomerDecisionConsumerCapability',
        'taskProposalRelinkProblem',
      ],
    ],
    [
      'libs/core/tier-guard.ts',
      ['isCustomerDecisionConsumerCapability', 'CUSTOMER_DECISION_CONSUMER_STORE_ROLE'],
    ],
    [
      'libs/core/authority.ts',
      ['isCustomerDecisionConsumerCapability', 'CUSTOMER_DECISION_CONSUMER_STORE_ROLE'],
    ],
    [
      'libs/core/foundation/customer-decision-write-content.ts',
      ['CUSTOMER_DECISION_CONSUMER_STORE_ROLE', 'customerDecisionConsumerWriteProblem'],
    ],
  ]),
});
