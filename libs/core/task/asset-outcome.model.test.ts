import { expect, it } from 'vitest';
import { checkFiniteStateSafety } from '../testing/finite-state-checker.js';
import {
  assertAssetShareAllowed,
  combineAssetTaint,
  type AssetTaint,
} from '../information-assets/asset-derivation.js';
import { createOutcomeContract } from './outcome-contract.js';
import { projectOutcomeResult } from './outcome-result.js';

it('preserves source restrictions and keeps delivery independent of verification', () => {
  const tiers = ['public', 'confidential', 'personal'] as const;
  const contract = createOutcomeContract({
    outcomeId: 'asset-report',
    requestedResult: 'Summarize the source',
    deliverableKind: 'markdown',
    successCriteria: ['Facts match'],
    verificationMethod: 'review_gate',
  });
  const scenarios = tiers.flatMap((sourceTier, sourceRank) =>
    tiers.flatMap((audienceFloor, audienceRank) =>
      [undefined, 'tenant-a', 'tenant-b'].flatMap((targetTenant) =>
        [false, true].map((external) => ({
          sourceTier,
          sourceRank,
          audienceFloor,
          audienceRank,
          targetTenant,
          external,
        }))
      )
    )
  );
  type State =
    | { stage: 'initial' }
    | {
        stage: 'projected';
        scenario: (typeof scenarios)[number];
        allowed: boolean;
        result: ReturnType<typeof projectOutcomeResult>;
      };
  const checked = checkFiniteStateSafety<State>({
    initial: [{ stage: 'initial' }],
    key: JSON.stringify,
    next: (state) =>
      state.stage === 'initial'
        ? scenarios.map((scenario) => {
            const publicSource: AssetTaint = {
              highestTier: 'public',
              tenants: [],
              prohibitExternal: false,
            };
            const taint = combineAssetTaint([
              publicSource,
              {
                highestTier: scenario.sourceTier,
                tenants: scenario.sourceRank ? ['tenant-a'] : [],
                prohibitExternal: scenario.sourceRank > 0,
              },
            ]);
            let allowed = true;
            try {
              assertAssetShareAllowed({ ...scenario, taint });
            } catch {
              allowed = false;
            }
            const result = projectOutcomeResult({
              contract,
              artifactRecords: [
                {
                  artifact_id: 'summary',
                  storage_class: 'artifact_store',
                  kind: 'markdown',
                  delivered_to: [
                    { binding_id: 'destination', status: allowed ? 'delivered' : 'failed' },
                  ],
                },
              ],
            });
            return {
              action: 'evaluate share and project delivery state',
              state: {
                stage: 'projected',
                scenario,
                allowed,
                result,
              },
            };
          })
        : [],
    invariants: {
      sourceRestriction: (state) =>
        state.stage === 'initial' ||
        state.allowed ===
          (state.scenario.sourceRank === 0 ||
            (state.scenario.audienceRank >= state.scenario.sourceRank &&
              !state.scenario.external &&
              state.scenario.targetTenant === 'tenant-a')),
      noInferredVerification: (state) =>
        state.stage === 'initial' || state.result.verification.status === 'unassessed',
      deliveryMatchesReceipt: (state) =>
        state.stage === 'initial' ||
        state.result.delivery.status === (state.allowed ? 'delivered' : 'failed'),
    },
  });
  expect(checked).toMatchObject({ status: 'verified', visited: 55, transitions: 54 });
});
