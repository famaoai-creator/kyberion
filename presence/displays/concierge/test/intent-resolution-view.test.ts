import { describe, expect, it } from 'vitest';
import type { IntentResolutionContract } from '@agent/core';
import { buildIntentResolutionView } from '../src/lib/intent-resolution-view';

const approvalContract: IntentResolutionContract = {
  request_id: 'ir-test',
  normalized_intent: 'send_message',
  missing_inputs: [],
  resolution_shape: 'task_session',
  outcome_kind: 'service_change',
  authority_level: 'approval_required',
  next_action: {
    kind: 'request_approval',
    label: 'Approve this plan to continue.',
    consequence: 'The requested action remains waiting and does not execute without approval.',
  },
  rationale: 'test fixture',
};

describe('concierge intent-resolution view', () => {
  it('projects all four contract questions without dropping approval details', () => {
    const view = buildIntentResolutionView(approvalContract);

    expect(view).toEqual({
      understood: 'send_message',
      missingInputs: [],
      nextAction: approvalContract.next_action,
      outcome: 'service_change',
      authority: 'approval_required',
    });
  });

  it('copies missing inputs so rendering cannot mutate the response contract', () => {
    const contract = { ...approvalContract, missing_inputs: ['recipient'] };
    const view = buildIntentResolutionView(contract);

    view.missingInputs.push('message');

    expect(contract.missing_inputs).toEqual(['recipient']);
  });
});
