import type {
  MissionProposal,
  SlackMissionProposalActionPayload,
} from './channel-surface-types.js';

function valueOrFallback(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * Render a mission proposal as an explicit Slack decision card.
 *
 * The plain-text fallback intentionally keeps the numbered grammar so that
 * clients without interactive blocks can use the same confirmation contract.
 */
export function buildSlackMissionProposalBlocks(proposal: MissionProposal): any[] {
  const summary = valueOrFallback(proposal.summary, 'Mission proposal');
  const missionType = valueOrFallback(proposal.mission_type, 'development');
  const tier = valueOrFallback(proposal.tier, 'public');
  const persona = valueOrFallback(proposal.assigned_persona, 'Ecosystem Architect');
  const why = valueOrFallback(proposal.why, 'This request is ready to be turned into a mission.');
  const fields = [`*Type*\n${missionType}`, `*Tier*\n${tier}`, `*Persona*\n${persona}`];
  if (proposal.vision_ref) fields.push(`*Vision*\n${proposal.vision_ref}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Mission proposal*\n*${summary}*\n${why}`,
      },
    },
    {
      type: 'section',
      fields: fields.map((text) => ({ type: 'mrkdwn', text })),
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '承認するとミッションを作成して実行を開始します。待つと保留、拒否すると提案を破棄します。',
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: '実行する' },
          action_id: 'slack_mission_proposal_decide',
          value: JSON.stringify({
            decision: 'approved',
          } satisfies SlackMissionProposalActionPayload),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'やめる' },
          action_id: 'slack_mission_proposal_decide',
          value: JSON.stringify({
            decision: 'rejected',
          } satisfies SlackMissionProposalActionPayload),
        },
      ],
    },
  ];
}

export function slackMissionProposalFallbackText(proposal: MissionProposal): string {
  const summary = valueOrFallback(proposal.summary, 'Mission proposal');
  return `${summary}\n1) 作成する 2) やめる`;
}

export function parseSlackMissionProposalAction(value: string): SlackMissionProposalActionPayload {
  const parsed = JSON.parse(value) as Partial<SlackMissionProposalActionPayload>;
  if (parsed.decision !== 'approved' && parsed.decision !== 'rejected') {
    throw new Error('Invalid Slack mission proposal decision');
  }
  return { decision: parsed.decision };
}
