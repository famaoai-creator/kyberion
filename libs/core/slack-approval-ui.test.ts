import { describe, expect, it } from 'vitest';
import { buildSlackApprovalBlocks } from './slack-approval-ui.js';

describe('Slack approval UI intent contract projection', () => {
  it('renders authority and next action alongside approval controls', () => {
    const blocks = buildSlackApprovalBlocks(
      {
        id: 'approval-1',
        title: 'Deploy',
        summary: 'Deploy the reviewed change.',
        severity: 'high',
        status: 'pending',
        channel: 'ops',
        threadTs: 'thread-1',
      } as never,
      {
        request_id: 'ir_slack_contract',
        normalized_intent: 'deploy_release',
        missing_inputs: [],
        resolution_shape: 'mission',
        outcome_kind: 'service_change',
        authority_level: 'approval_required',
        next_action: {
          kind: 'request_approval',
          label: 'Approve this release.',
          consequence: 'The release waits until approval is recorded.',
        },
        rationale: 'approval is required',
      }
    );

    const contractBlock = blocks.find((block: { type?: string; text?: { text?: string } }) =>
      block.text?.text?.includes('*Authority:*')
    );
    expect(contractBlock?.text?.text).toContain('*Authority:* human approval required');
    expect(contractBlock?.text?.text).toContain('*Next action:* Approve this release.');
    expect(contractBlock?.text?.text).toContain(
      '*Consequence:* The release waits until approval is recorded.'
    );
    expect(contractBlock?.text?.text).toContain('*Outcome:* service change');
    expect(contractBlock?.text?.text).not.toContain('approval_required');
  });
});
