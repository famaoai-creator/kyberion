import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExec, safeExistsSync, safeReaddir } from './secure-io.js';
import { type GovernedArtifactRole } from './artifact-store.js';
import {
  deriveSlackExecutionMode,
  deriveSlackIntentLabel,
  runSurfaceConversation,
  runSurfaceMessageConversation,
  shouldForceSlackDelegation,
  buildSlackSurfacePrompt,
} from './surface-runtime-orchestrator.js';
import {
  emitChannelSurfaceEvent,
  recordChronosDelegationSummary,
  recordChronosSurfaceRequest,
  recordSlackDelivery,
  recordSlackSurfaceArtifact,
} from './surface-artifact-store.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
export {
  emitChannelSurfaceEvent,
  recordChronosDelegationSummary,
  recordChronosSurfaceRequest,
  recordSlackDelivery,
  recordSlackSurfaceArtifact,
} from './surface-artifact-store.js';
export {
  clearSlackOutboxMessage,
  clearSurfaceOutboxMessage,
  createSurfaceAsyncRequest,
  enqueueChronosOutboxMessage,
  enqueueSlackOutboxMessage,
  enqueueSurfaceNotification,
  getSurfaceAsyncRequest,
  listSlackOutboxMessages,
  listSurfaceAsyncRequests,
  listSurfaceNotifications,
  listSurfaceOutboxMessages,
  updateSurfaceAsyncRequest,
} from './surface-coordination-store.js';
export {
  deriveSlackDelegationReceiver,
  deriveSurfaceDelegationReceiver,
  resolveSurfaceConversationReceiver,
} from './surface-runtime-router.js';
export {
  buildSlackSurfacePrompt,
  deriveSlackExecutionMode,
  deriveSlackIntentLabel,
  runSurfaceConversation,
  runSurfaceMessageConversation,
  shouldForceSlackDelegation,
} from './surface-runtime-orchestrator.js';
export { extractSurfaceBlocks } from './surface-response-blocks.js';
export {
  applySlackApprovalDecision,
  buildSlackApprovalBlocks,
  createSlackApprovalRequest,
  loadSlackApprovalRequest,
  parseSlackApprovalAction,
} from './slack-approval-ui.js';
export {
  buildSlackOnboardingBlocks,
  buildSlackOnboardingModal,
  buildSlackOnboardingPrompt,
  getSlackOnboardingState,
  handleSlackOnboardingTurn,
  isEnvironmentInitialized,
  parseSlackOnboardingAction,
} from './slack-onboarding.js';
export {
  clearChronosMissionProposalState,
  clearSlackMissionProposalState,
  getChronosMissionProposalState,
  getSlackMissionProposalState,
  isSlackMissionConfirmation,
  issueChronosMissionFromProposal,
  issueSlackMissionFromProposal,
  saveChronosMissionProposalState,
  saveSlackMissionProposalState,
} from './surface-mission-proposals.js';

import type {
  SlackSurfaceInput,
  SlackExecutionMode,
  SlackSurfaceArtifact,
  ChronosSurfaceRequest,
  // Internal aliases
  SlackOutboxMessage,
} from './channel-surface-types.js';

export type {
  SurfaceConversationResult,
  SlackSurfaceInput,
  SlackExecutionMode,
  SlackSurfaceArtifact,
  ChronosSurfaceRequest,
  SurfaceConversationInput,
  NerveRoutingProposal,
  MissionProposal,
  PlanningPacketTask,
  PlanningPacket,
  SurfaceOutboxMessage,
  SlackMissionIssuanceResult,
  SlackApprovalActionPayload,
  SlackOnboardingPrompt,
  SlackOnboardingActionPayload,
  OnboardingTurnResult,
} from './channel-surface-types.js';

export type { SlackApprovalRequestDraft, SlackApprovalRequestRecord, SlackOutboxMessage } from './channel-surface-types.js';

export function prepareSlackSurfaceArtifact(input: SlackSurfaceInput): SlackSurfaceArtifact {
  const ts = new Date().toISOString();
  const correlationId = randomUUID();
  const stimulusId = correlationId;
  const threadTs = input.threadTs || input.ts || ts;
  const context = `${input.channel}:${threadTs}`;
  const cleanPayload = input.text.trim();
  const shouldAck = input.channelType === 'im';
  const ackText = 'Received. I am routing this to Kyberion now.';

  const stimulus = {
    id: stimulusId,
    ts,
    ttl: 3600,
    origin: {
      channel: 'slack' as const,
      source_id: input.user,
      context,
      metadata: {
        team: input.team,
        channel_type: input.channelType,
        thread_ts: threadTs,
        correlation_id: correlationId,
      },
    },
    signal: {
      type: 'CHAT' as const,
      priority: input.channelType === 'im' ? 7 : 5,
      payload: cleanPayload,
    },
    policy: {
      flow: 'LOOPBACK' as const,
      feedback: 'auto' as const,
      retention: 'ephemeral' as const,
    },
    control: {
      status: 'pending' as const,
      evidence: [
        {
          step: 'slack_surface_agent_prepared_handoff',
          ts,
          agent: 'slack-surface-agent',
        },
      ],
    },
  };

  const inboxPath = `active/shared/coordination/channels/slack/inbox/${stimulusId}.json`;
  return { stimulus, correlationId, inboxPath, shouldAck, ackText };
}
