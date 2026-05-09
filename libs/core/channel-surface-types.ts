/**
 * libs/core/channel-surface-types.ts
 * Centralized type definitions extracted from channel-surface.ts.
 * These types define the contracts for surface interactions (Slack, Chronos, A2A).
 */

import type { ApprovalRequestDraft, ApprovalRequestRecord } from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import type { A2AMessage } from './a2a-bridge.js';
import type { A2UIMessage } from './a2ui.js';
import type { AgentRoutingDecision } from './intent-contract.js';

export type SurfaceRole = GovernedArtifactRole;

// ─── Shared Surface Event ────────────────────────────────────────────────────
export interface SurfaceEvent {
  ts: string;
  event_id: string;
  channel: string;
  correlation_id: string;
  decision: string;
  why: string;
  policy_used: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  resource_id?: string;
  [key: string]: unknown;
}

// ─── Slack Surface ────────────────────────────────────────────────────────────
export interface SlackSurfaceInput {
  user?: string;
  text: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  team?: string;
  channelType?: string;
}

export type SlackExecutionMode = 'conversation' | 'task';

export interface SlackSurfaceArtifact {
  stimulus: {
    id: string;
    ts: string;
    ttl: number;
    origin: {
      channel: 'slack';
      source_id?: string;
      context: string;
      metadata: Record<string, unknown>;
    };
    signal: {
      type: 'CHAT';
      priority: number;
      payload: string;
    };
    policy: {
      flow: 'LOOPBACK';
      feedback: 'auto';
      retention: 'ephemeral';
    };
    control: {
      status: 'pending';
      evidence: Array<{ step: string; ts: string; agent: string }>;
    };
  };
  correlationId: string;
  inboxPath: string;
  shouldAck: boolean;
  ackText: string;
}

export type SlackApprovalRequestDraft = ApprovalRequestDraft;
export type SlackApprovalRequestRecord = ApprovalRequestRecord;

export interface SlackMissionIssuanceResult {
  missionId: string;
  tier: 'personal' | 'confidential' | 'public';
  missionType: string;
  persona: string;
  startOutput: string;
  orchestrationStatus: 'queued' | 'failed';
  orchestrationJobPath?: string;
  orchestrationError?: string;
  routingDecision?: AgentRoutingDecision;
}

export interface SlackApprovalActionPayload {
  requestId: string;
  decision: 'approved' | 'rejected';
}

export interface SlackOutboxMessage extends SurfaceOutboxMessage {}

// ─── Onboarding ───────────────────────────────────────────────────────────────
export type OnboardingField =
  | 'name'
  | 'language'
  | 'interaction_style'
  | 'primary_domain'
  | 'vision'
  | 'agent_id';

export interface SlackOnboardingPrompt {
  field: OnboardingField;
  text: string;
}

export interface SlackOnboardingActionPayload {
  channel: string;
  threadTs: string;
  field: OnboardingField;
  answer?: string;
}

export interface OnboardingTurnResult {
  replyText: string;
  completed: boolean;
}

// ─── Chronos Surface ──────────────────────────────────────────────────────────
export interface ChronosSurfaceRequest {
  query: string;
  sessionId?: string;
  requesterId?: string;
}

// ─── Nerve / Routing ──────────────────────────────────────────────────────────
export interface NerveRoutingProposal {
  intent: 'delegate_task';
  mission_id?: string;
  team_role: string;
  task_summary?: string;
  why?: string;
}

export interface MissionProposal {
  intent: 'create_mission';
  mission_type?: string;
  summary?: string;
  assigned_persona?: string;
  tier?: 'personal' | 'confidential' | 'public';
  vision_ref?: string;
  why?: string;
}

export interface PlanningPacketTask {
  task_id: string;
  team_role: string;
  description: string;
  deliverable?: string;
  target_path?: string;
}

export interface PlanningPacket {
  mission_id?: string;
  summary?: string;
  plan_markdown: string;
  next_tasks: PlanningPacketTask[];
}

// ─── A2A / Conversation ───────────────────────────────────────────────────────
export interface SlackSurfaceMetadata {
  surface: 'slack';
  user?: string;
  team?: string;
  channel: string;
  threadTs: string;
  channelType?: string;
  execution_mode?: SlackExecutionMode;
}

export type SurfaceAsyncChannel = string; // Extensible string, replacing fixed unions

export interface BaseSurfaceMetadata {
  surface: SurfaceAsyncChannel;
  actorId?: string;
  channel: string;
  threadTs: string;
  [key: string]: any;
}

export interface SlackSurfaceMetadata extends BaseSurfaceMetadata {
  surface: 'slack';
  user?: string;
  team?: string;
  channelType?: string;
  execution_mode?: SlackExecutionMode;
}

export interface ChronosSurfaceMetadata extends BaseSurfaceMetadata {
  surface: 'chronos';
}

export interface PresenceSurfaceMetadata extends BaseSurfaceMetadata {
  surface: 'presence';
}

export interface IMessageSurfaceMetadata extends BaseSurfaceMetadata {
  surface: 'imessage';
}

export interface DiscordSurfaceMetadata extends BaseSurfaceMetadata {
  surface: 'discord';
}

export type SurfaceConversationMetadata = 
  | SlackSurfaceMetadata 
  | ChronosSurfaceMetadata
  | PresenceSurfaceMetadata
  | IMessageSurfaceMetadata
  | DiscordSurfaceMetadata
  | BaseSurfaceMetadata;

interface SurfaceConversationInputBase {
  agentId: string;
  query: string;
  senderAgentId: string;
  surfaceText?: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
}

export type SurfaceConversationInput = SurfaceConversationInputBase & {
  surface?: SurfaceAsyncChannel;
  surfaceMetadata?: SurfaceConversationMetadata;
};

interface SurfaceConversationMessageInputBase {
  text: string;
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
  senderAgentId: string;
  agentId?: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
}

export type SurfaceConversationMessageInput = SurfaceConversationMessageInputBase & {
  surface: SurfaceAsyncChannel;
  channel?: string;
  threadTs?: string;
  actorId?: string;
  metadata?: Record<string, any>;
};

export interface SurfaceConversationResult {
  text: string;
  a2uiMessages: A2UIMessage[];
  a2aMessages: A2AMessage[];
  delegationResults: SurfaceDelegationResult[];
  approvalRequests: SlackApprovalRequestDraft[];
  routingProposals?: NerveRoutingProposal[];
  missionProposals?: MissionProposal[];
  planningPackets?: PlanningPacket[];
  routingDecision?: AgentRoutingDecision;
}

export interface SurfaceDelegationResult {
  receiver?: string;
  response?: string;
  error?: string;
  bypassedSurfaceAgent?: boolean;
  missionId?: string;
  teamRole?: string;
  authorityRole?: string;
}

export interface SurfaceAsyncRequestRecord {
  request_id: string;
  surface: SurfaceAsyncChannel;
  channel: string;
  thread_ts: string;
  sender_agent_id: string;
  surface_agent_id: string;
  receiver_agent_id: string;
  query: string;
  accepted_text: string;
  status: 'pending' | 'completed' | 'failed';
  result_text?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface SurfaceNotificationRecord {
  notification_id: string;
  request_id?: string;
  surface: SurfaceAsyncChannel;
  channel: string;
  thread_ts: string;
  source_agent_id: string;
  title: string;
  text: string;
  status: 'info' | 'success' | 'error';
  created_at: string;
}

export interface SurfaceOutboxMessage {
  message_id: string;
  surface: SurfaceAsyncChannel;
  correlation_id: string;
  channel: string;
  thread_ts: string;
  text: string;
  source: 'surface' | 'nerve' | 'system';
  created_at: string;
}

export interface SlackOutboxMessage extends SurfaceOutboxMessage {}

// ─── Private/Internal State Types ────────────────────────────────────────────
export interface ParsedSlackSurfacePrompt {
  channel?: string;
  thread?: string;
  user?: string;
  derivedLanguage?: string;
  executionMode?: SlackExecutionMode;
  userMessage: string;
}

export interface OnboardingState {
  channel: string;
  threadTs: string;
  currentField: OnboardingField;
  answers: Partial<Record<OnboardingField, string>>;
  completed: boolean;
  updatedAt: string;
}

export interface SlackMissionProposalState {
  surface?: 'slack';
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  createdAt: string;
}

export interface ChronosMissionProposalState {
  surface: 'chronos';
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  createdAt: string;
}
