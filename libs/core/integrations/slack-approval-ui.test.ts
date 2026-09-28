import { describe, expect, it } from 'vitest';
import { APPROVAL_CHANGE_INSTRUCTION_MAX } from '../governance/approval-store.js';
import {
  buildSlackApprovalBlocks,
  buildSlackChangeRequestModal,
  parseSlackApprovalAction,
  parseSlackAskWhyAction,
  parseSlackCardAction,
  parseSlackChangeRequestSubmission,
  SLACK_CHANGE_REQUEST_CALLBACK_ID,
} from './slack-approval-ui.js';

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
    expect(contractBlock?.text?.text).toContain('*Understanding:* deploy_release');
    expect(contractBlock?.text?.text).toContain('*Missing input:* None');
    expect(contractBlock?.text?.text).toContain('*Next action:* Approve this release.');
    expect(contractBlock?.text?.text).toContain(
      '*Consequence:* The release waits until approval is recorded.'
    );
    expect(contractBlock?.text?.text).toContain('*Outcome:* service change');
    expect(contractBlock?.text?.text).not.toContain('approval_required');
  });

  it('uses the requested locale for contract labels and approval controls', () => {
    const blocks = buildSlackApprovalBlocks(
      {
        id: 'approval-ja',
        title: '送信',
        summary: '確認済みの内容を送信します。',
        severity: 'medium',
        status: 'pending',
        channel: 'ops',
        threadTs: 'thread-ja',
      } as never,
      {
        request_id: 'ir_slack_ja',
        normalized_intent: 'send_message',
        missing_inputs: [],
        resolution_shape: 'task_session',
        outcome_kind: 'service_change',
        authority_level: 'approval_required',
        next_action: {
          kind: 'request_approval',
          label: '承認してください',
          consequence: '承認されるまで待機します。',
        },
        rationale: 'approval is required',
      },
      'ja'
    );
    const contractBlock = blocks.find((block: { type?: string; text?: { text?: string } }) =>
      block.text?.text?.includes('*権限:*')
    );
    expect(contractBlock?.text?.text).toContain('*権限:* 人間の承認が必要');
    const actions = blocks.find((block: { type?: string }) => block.type === 'actions');
    expect(
      actions?.elements?.map((element: { text?: { text?: string } }) => element.text?.text)
    ).toEqual(['承認', '却下']);
  });

  it('rejects malformed or prototype-bearing action payloads before dispatch', () => {
    expect(() => parseSlackApprovalAction('{"requestId":"approval-1","decision":"other"}')).toThrow(
      /valid decision/u
    );
    expect(() =>
      parseSlackApprovalAction('{"requestId":"approval-1","decision":"approved","__proto__":{}}')
    ).toThrow(/dangerous JSON key/u);
    expect(() => parseSlackAskWhyAction('{"requestId":"approval-1","category":"unknown"}')).toThrow(
      /valid category/u
    );
  });
});

describe('Slack decision card', () => {
  const record = {
    id: 'approval-card-1',
    title: 'Billing change',
    summary: 'Adjust invoice rounding.',
    severity: 'high',
    status: 'pending',
    channel: 'ops',
    threadTs: 'thread-1',
    decisionCard: {
      question: 'Ship the billing change?',
      recommendation: 'Approve after CI is green.',
      riskTier: 'approve',
      riskReasons: ['touches billing'],
      reversible: false,
      evidence: [],
    },
  };

  function actionIds(blocks: { type?: string; elements?: { action_id?: string }[] }[]) {
    return blocks
      .filter((block) => block.type === 'actions')
      .flatMap((block) => (block.elements ?? []).map((element) => element.action_id));
  }

  it('adds the card body and the changes / explain buttons only when a card exists', () => {
    const blocks = buildSlackApprovalBlocks(record as never, undefined, 'en');
    expect(JSON.stringify(blocks)).toContain('Ship the billing change?');
    expect(actionIds(blocks)).toEqual([
      'slack_approval_decide',
      'slack_approval_decide',
      'slack_approval_changes',
      'slack_approval_explain',
    ]);
    const legacy = buildSlackApprovalBlocks(
      { ...record, decisionCard: undefined } as never,
      undefined,
      'en'
    );
    expect(actionIds(legacy)).toEqual(['slack_approval_decide', 'slack_approval_decide']);
  });

  it('escapes agent-written card text so it cannot mention or link', () => {
    const blocks = buildSlackApprovalBlocks(
      {
        ...record,
        decisionCard: { ...record.decisionCard, riskReasons: ['<!channel> <https://evil|ok>'] },
      } as never,
      undefined,
      'en'
    );
    const text = JSON.stringify(blocks);
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('parses card button values and rejects malformed ones', () => {
    expect(parseSlackCardAction(JSON.stringify({ requestId: 'r-1' }))).toEqual({
      requestId: 'r-1',
    });
    expect(() => parseSlackCardAction(JSON.stringify({}))).toThrow(/requestId/u);
  });

  it('round-trips the change request modal through its submission', () => {
    const view = buildSlackChangeRequestModal(
      { requestId: 'r-1', channel: 'ops', threadTs: 'thread-1' },
      'en'
    );
    expect(view.callback_id).toBe(SLACK_CHANGE_REQUEST_CALLBACK_ID);
    expect(view.blocks[0].element.max_length).toBe(APPROVAL_CHANGE_INSTRUCTION_MAX);
    const blockId = view.blocks[0].block_id as string;
    expect(
      parseSlackChangeRequestSubmission({
        private_metadata: view.private_metadata,
        state: { values: { [blockId]: { value: { value: 'shorten it' } } } },
      })
    ).toEqual({
      requestId: 'r-1',
      channel: 'ops',
      threadTs: 'thread-1',
      instruction: 'shorten it',
    });
    expect(() => parseSlackChangeRequestSubmission({ private_metadata: '{}' })).toThrow(
      /metadata/u
    );
  });
});
