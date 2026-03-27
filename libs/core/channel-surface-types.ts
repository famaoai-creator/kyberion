/**
 * libs/core/channel-surface-types.ts
 * Centralized type definitions extracted from channel-surface.ts.
 * These types define the contracts for surface interactions (Slack, Chronos, A2A).
 */

import type { ApprovalRequestDraft, ApprovalRequestRecord } from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';

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
}

export interface PlanningPacket {
  mission_id?: string;
  summary?: string;
  plan_markdown: string;
  next_tasks: PlanningPacketTask[];
}

// ─── A2A / Conversation ───────────────────────────────────────────────────────
export interface SurfaceConversationInput {
  agentId: string;
  query: string;
  senderAgentId: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
}

export interface SurfaceConversationResult {
  text: string;
  a2uiMessages: any[];
  a2aMessages: any[];
  delegationResults: any[];
  approvalRequests: SlackApprovalRequestDraft[];
  routingProposals?: NerveRoutingProposal[];
  missionProposals?: MissionProposal[];
  planningPackets?: PlanningPacket[];
}

export type SurfaceAsyncChannel = 'slack' | 'chronos' | 'presence';

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
  surface: 'slack' | 'chronos';
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
  createdAt: string;
}

export interface ChronosMissionProposalState {
  surface: 'chronos';
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  createdAt: string;
}
