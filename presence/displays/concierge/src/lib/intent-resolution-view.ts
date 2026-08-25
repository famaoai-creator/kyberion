import type { IntentResolutionContract } from '@agent/core';

/**
 * Surface projection for the four questions in IntentResolutionContract.
 * Keeping this projection outside the component makes it possible to test
 * that the UI cannot accidentally omit a contract field while changing JSX.
 */
export interface IntentResolutionView {
  understood: string;
  missingInputs: string[];
  nextAction: IntentResolutionContract['next_action'];
  outcome: IntentResolutionContract['outcome_kind'];
  authority: IntentResolutionContract['authority_level'];
}

export function buildIntentResolutionView(
  contract: IntentResolutionContract
): IntentResolutionView {
  return {
    understood: contract.normalized_intent,
    missingInputs: [...contract.missing_inputs],
    nextAction: { ...contract.next_action },
    outcome: contract.outcome_kind,
    authority: contract.authority_level,
  };
}
