import type { IntentResolutionContract } from '../intent/intent-resolution-contract-parser.js';
import type { SupportedLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import type { SurfaceConversationResult } from './channel-surface.js';

export type FrontDeskConversationShape =
  'clarification' | 'execution_preview' | 'status_summary' | 'delivery_summary' | 'reply';

export interface FrontDeskConversationNextAction {
  id: string;
  /** Sent verbatim as the next conversation turn by interactive adapters. */
  label: string;
}

export interface FrontDeskConversationPromotion {
  kind: 'mission' | 'task_session';
  label: string;
}

/** A conversation reply is not a receipt that durable work completed. */
export interface FrontDeskRequestReply {
  reply: string;
  mode: 'orchestrator' | 'intake';
  shape: FrontDeskConversationShape;
  promoted?: FrontDeskConversationPromotion;
  nextActions?: FrontDeskConversationNextAction[];
  intentResolution?: IntentResolutionContract;
  conversationRuntime?: SurfaceConversationResult['conversationRuntime'];
}

function viewFromIntentResolution(
  contract: IntentResolutionContract
): Pick<FrontDeskRequestReply, 'shape' | 'nextActions'> {
  if (contract.authority_level === 'human_clarification_required') {
    return {
      shape: 'clarification',
      nextActions: [{ id: 'provide_input', label: contract.next_action.label }],
    };
  }
  if (contract.authority_level === 'approval_required') {
    return {
      shape: 'execution_preview',
      nextActions: [{ id: 'approve', label: contract.next_action.label }],
    };
  }
  return { shape: 'reply' };
}

/** Project only distinctions established by the shared orchestrator result. */
function deriveConversationView(
  conversation: SurfaceConversationResult,
  locale?: SupportedLocale
): Pick<FrontDeskRequestReply, 'shape' | 'promoted' | 'nextActions'> {
  const missionProposal = conversation.missionProposals?.[0];
  if (missionProposal) {
    const label = String(
      missionProposal.summary || missionProposal.why || missionProposal.mission_type || ''
    ).trim();
    return {
      shape: 'execution_preview',
      promoted: label ? { kind: 'mission', label } : undefined,
      nextActions: [
        { id: 'confirm', label: t('concierge:dock.confirm_proceed', {}, locale) },
        { id: 'cancel', label: t('concierge:dock.decline_proceed', {}, locale) },
      ],
    };
  }
  if (conversation.approvalRequests?.length) return { shape: 'execution_preview' };
  if (conversation.delegationResults?.length) {
    const delegated = conversation.delegationResults.find((entry) => entry.missionId);
    return {
      shape: 'delivery_summary',
      promoted: delegated?.missionId
        ? { kind: 'task_session', label: delegated.missionId }
        : undefined,
    };
  }
  return { shape: 'reply' };
}

/** Shared by text adapters; deliberately never used for a durable replay. */
export function projectFrontDeskConversationReply(
  conversation: SurfaceConversationResult,
  locale?: SupportedLocale
): FrontDeskRequestReply {
  const reply = typeof conversation?.text === 'string' ? conversation.text.trim() : '';
  if (!reply) throw new Error('empty orchestrator reply');
  const intentView =
    conversation.intentResolution && conversation.intentResolution.authority_level !== 'autonomous'
      ? viewFromIntentResolution(conversation.intentResolution)
      : undefined;
  return {
    reply,
    mode: 'orchestrator',
    ...(conversation.conversationRuntime
      ? { conversationRuntime: conversation.conversationRuntime }
      : {}),
    ...deriveConversationView(conversation, locale),
    ...(conversation.intentResolution ? { intentResolution: conversation.intentResolution } : {}),
    ...(intentView || {}),
  };
}
