import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the tenant autonomy learning grant is module-private. Only the governed
// autonomy action state facade issues it; tier-guard and authority.ts ask the
// pure predicate while the dedicated role still exists.
describeStoreGrantBoundary('Autonomy learning grant trusted import boundary', {
  implementation: 'libs/core/foundation/autonomy-learning-capability.ts',
  issuers: new Map([
    ['withAutonomyLearningCapability', ['libs/core/governance/autonomy-action-state.ts']],
  ]),
  consumers: new Map([
    ['libs/core/governance/autonomy-action-state.ts', ['withAutonomyLearningCapability']],
    ['libs/core/tier-guard.ts', ['isAutonomyLearningCapability']],
    ['libs/core/authority.ts', ['isAutonomyLearningCapability']],
  ]),
});
