import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the tenant autonomy learning grant is module-private and is itself the
// authority. Only the governed autonomy action state facade issues it; the
// tier-guard store-grant table asks the authority predicate. authority.ts and
// tier-guard.ts no longer import it (the role is gone).
describeStoreGrantBoundary(
  'Autonomy learning grant trusted import boundary',
  {
    implementation: 'libs/core/foundation/autonomy-learning-capability.ts',
    issuers: new Map([
      ['withAutonomyLearningCapability', ['libs/core/governance/autonomy-action-state.ts']],
    ]),
    consumers: new Map([
      [
        'libs/core/governance/autonomy-action-state.ts',
        ['withAutonomyLearningCapability', 'AUTONOMY_LEARNING_GRANT_ISSUANCE_RIGHT'],
      ],
    ]),
  },
  {
    formerConsumers: [
      'libs/core/tier-guard.ts',
      'libs/core/authority.ts',
      'libs/core/tier-guard-store-grants.ts',
    ],
  }
);
