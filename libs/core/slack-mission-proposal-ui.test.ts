import { describe, expect, it } from 'vitest';
import {
  buildSlackMissionProposalBlocks,
  parseSlackMissionProposalAction,
  slackMissionProposalFallbackText,
} from './slack-mission-proposal-ui.js';

describe('Slack mission proposal UI (UX-04)', () => {
  const proposal = {
    intent: 'create_mission' as const,
    mission_type: 'product_development',
    summary: 'Create a Kyberion marketing deck',
    assigned_persona: 'Ecosystem Architect',
    tier: 'public' as const,
    why: 'The request needs a tracked multi-step execution.',
  };

  it('renders explicit approve and reject actions', () => {
    const blocks = buildSlackMissionProposalBlocks(proposal);
    const actionsBlock = blocks.find((block: any) => block.type === 'actions');
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0].action_id).toBe('slack_mission_proposal_decide');
    expect(parseSlackMissionProposalAction(actionsBlock.elements[0].value).decision).toBe(
      'approved'
    );
    expect(parseSlackMissionProposalAction(actionsBlock.elements[1].value).decision).toBe(
      'rejected'
    );
  });

  it('keeps a numbered fallback for clients without interactive blocks', () => {
    expect(slackMissionProposalFallbackText(proposal)).toContain('1) 作成する 2) やめる');
  });

  it('rejects malformed action payloads', () => {
    expect(() => parseSlackMissionProposalAction(JSON.stringify({ decision: 'later' }))).toThrow(
      'Invalid Slack mission proposal decision'
    );
  });
});
