import type {
  MissionProposal,
  SlackMissionProposalActionPayload,
} from './channel-surface-types.js';
import { parseSafeJsonObjectInput } from './foundation/safe-json.js';
import type { SupportedLocale } from './locale-normalize.js';
import { t } from './t.js';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
  type IntentResolutionContract,
} from './intent-resolution-contract.js';

function valueOrFallback(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/**
 * Render a mission proposal as an explicit Slack decision card.
 *
 * The plain-text fallback intentionally keeps the numbered grammar so that
 * clients without interactive blocks can use the same confirmation contract.
 */
export function buildSlackMissionProposalBlocks(
  proposal: MissionProposal,
  intentResolution?: IntentResolutionContract,
  locale?: SupportedLocale
): any[] {
  const contractLocale: SupportedLocale = locale ?? 'en';
  const uiLocale: SupportedLocale = locale ?? 'ja';
  const summary = valueOrFallback(
    proposal.summary,
    t('bridge:mission_proposal_fallback', undefined, uiLocale)
  );
  const missionType = valueOrFallback(proposal.mission_type, 'development');
  const tier = valueOrFallback(proposal.tier, 'public');
  const persona = valueOrFallback(proposal.assigned_persona, 'Ecosystem Architect');
  const why = valueOrFallback(proposal.why, 'This request is ready to be turned into a mission.');
  const fields = [
    t('bridge:mission_issued_type', { missionType }, uiLocale),
    t('bridge:mission_issued_tier', { tier }, uiLocale),
    t('bridge:mission_issued_persona', { persona }, uiLocale),
  ];
  if (proposal.vision_ref) fields.push(`*Vision*\n${proposal.vision_ref}`);

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${t('bridge:mission_proposal_fallback', undefined, uiLocale)}*\n*${summary}*\n${why}`,
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
          text: [
            t('chronos:chronos_mission_confirm_alert_message', undefined, uiLocale),
            ...(intentResolution
              ? [
                  `${t('bridge:contract_authority', undefined, contractLocale)}: ${renderIntentAuthorityLabel(intentResolution.authority_level, contractLocale)}`,
                  `${t('bridge:contract_next_action', undefined, contractLocale)}: ${intentResolution.next_action.label}`,
                  `${t('bridge:contract_consequence', undefined, contractLocale)}: ${intentResolution.next_action.consequence}`,
                  `${t('bridge:contract_outcome', undefined, contractLocale)}: ${renderIntentOutcomeLabel(intentResolution.outcome_kind, contractLocale)}`,
                ]
              : []),
          ].join('\n'),
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: {
            type: 'plain_text',
            text: t('chronos:chronos_approve_start', undefined, uiLocale),
          },
          action_id: 'slack_mission_proposal_decide',
          value: JSON.stringify({
            decision: 'approved',
          } satisfies SlackMissionProposalActionPayload),
        },
        {
          type: 'button',
          style: 'danger',
          text: {
            type: 'plain_text',
            text: t('bridge:approval_reject_button', undefined, uiLocale),
          },
          action_id: 'slack_mission_proposal_decide',
          value: JSON.stringify({
            decision: 'rejected',
          } satisfies SlackMissionProposalActionPayload),
        },
      ],
    },
  ];
}

export function slackMissionProposalFallbackText(
  proposal: MissionProposal,
  intentResolution?: IntentResolutionContract,
  locale?: SupportedLocale
): string {
  const contractLocale: SupportedLocale = locale ?? 'en';
  const uiLocale: SupportedLocale = locale ?? 'ja';
  const summary = valueOrFallback(
    proposal.summary,
    t('bridge:mission_proposal_fallback', undefined, uiLocale)
  );
  return [
    `${summary}\n${t('bridge:mission_proposal_confirmation_choices', undefined, uiLocale)}`,
    ...(intentResolution
      ? [
          `${t('bridge:contract_authority', undefined, contractLocale)}: ${renderIntentAuthorityLabel(intentResolution.authority_level, contractLocale)}`,
          `${t('bridge:contract_next_action', undefined, contractLocale)}: ${intentResolution.next_action.label}`,
          `${t('bridge:contract_consequence', undefined, contractLocale)}: ${intentResolution.next_action.consequence}`,
          `${t('bridge:contract_outcome', undefined, contractLocale)}: ${renderIntentOutcomeLabel(intentResolution.outcome_kind, contractLocale)}`,
        ]
      : []),
  ].join('\n');
}

export function parseSlackMissionProposalAction(value: string): SlackMissionProposalActionPayload {
  const parsed = parseSafeJsonObjectInput(value, 'Slack mission proposal action');
  if (!parsed || (parsed.decision !== 'approved' && parsed.decision !== 'rejected')) {
    throw new Error('Invalid Slack mission proposal decision');
  }
  return { decision: parsed.decision };
}
