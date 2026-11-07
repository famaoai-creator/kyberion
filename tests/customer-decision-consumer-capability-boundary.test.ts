import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the customer decision consumer-lock grant is module-private and is itself
// the authority. Only the governed facade issues it, and only the mission decision
// lock and the operator re-ask facade call it; the store-grant table asks the
// authority predicate and the narrow store denial applies the CD-09 content rules
// to every write inside a live grant. tier-guard and authority.ts no longer import it.
describeStoreGrantBoundary(
  'Customer decision consumer grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/customer-decision-consumer-capability.ts',
    issuers: new Map([
      [
        'withCustomerDecisionConsumerCapability',
        ['libs/core/customer-decision/consumer-grant-access.ts'],
      ],
    ]),
    consumers: new Map([
      [
        'libs/core/customer-decision/consumer-grant-access.ts',
        [
          'CUSTOMER_DECISION_CONSUMER_GRANT_ISSUANCE_RIGHT',
          'withCustomerDecisionConsumerCapability',
        ],
      ],
      [
        'libs/core/mission/mission-decision-lock.ts',
        ['customerDecisionsRootDir', 'runInCustomerDecisionConsumerSweep'],
      ],
      ['libs/core/customer-decision/store.ts', ['taskProposalRelinkProblem']],
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

describeStoreGrantBoundary('Customer decision consumer grant facade trusted import boundary', {
  implementation: 'libs/core/customer-decision/consumer-grant-access.ts',
  issuers: new Map([
    [
      'withCustomerDecisionConsumerGrant',
      ['libs/core/mission/mission-decision-lock.ts', 'libs/core/customer-decision/store.ts'],
    ],
  ]),
  consumers: new Map([
    ['libs/core/mission/mission-decision-lock.ts', ['withCustomerDecisionConsumerGrant']],
    ['libs/core/customer-decision/store.ts', ['withCustomerDecisionConsumerGrant']],
  ]),
});
