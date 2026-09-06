/**
 * libs/core/channel-surface-types.ts
 * Centralized type definitions extracted from channel-surface.ts.
 * These types define the contracts for surface interactions (Slack, Chronos, A2A).
 */

import type { ApprovalRequestDraft, ApprovalRequestRecord } from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import type { A2AMessage } from './a2a-bridge.js';
import type { A2UIMessage } from './a2ui.js';
import type { AgentContextMode } from './context-boundary.js';
import type { AgentRoutingDecision } from './intent-contract.js';
import type { IntentResolutionContract } from './intent-resolution-contract.js';
import type { SupportedLocale } from './locale-normalize.js';
import type {
  ExecutionFeedbackInput,
  ExecutionFeedbackRecord,
  ExecutionFeedbackRequest,
} from './execution-feedback.js';
import type { EventScope, EventScopeInput } from './event-scope.js';

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
  scope?: EventScope;
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

export interface SlackMissionProposalActionPayload {
  decision: 'approved' | 'rejected';
}

export interface SlackOutboxMessage extends SurfaceOutboxMessage {}

// ─── Onboarding ───────────────────────────────────────────────────────────────
export type OnboardingField =
  'name' | 'language' | 'interaction_style' | 'primary_domain' | 'vision' | 'agent_id';

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
  dependencies?: string[];
  acceptance_criteria?: string[];
  risk?: 'low' | 'medium' | 'high' | 'approval_required' | 'high_stakes';
  expected_output_format?: 'text' | 'files' | 'structured';
  estimated_scope?: 'S' | 'M' | 'L';
  review_target?: string;
}

export interface PlanningPacket {
  mission_id?: string;
  summary?: string;
  plan_markdown: string;
  next_tasks: PlanningPacketTask[];
}

export interface TaskResultArtifact {
  path: string;
  kind: string;
}

export interface TaskReviewFinding {
  severity: 'must_fix' | 'should_fix' | 'nit';
  location: string;
  instruction: string;
}

export interface TaskAcceptanceEvidence {
  criterion: string;
  status: 'passed' | 'failed';
  evidence: string;
}

/**
 * KP-05: optional bridge back from a worker's task_result to the knowledge
 * provisioning loop — which delivered `knowledge_hints` (by document path,
 * see `MissionContextPackKnowledgeHint.path` in mission-context-pack.ts)
 * actually helped, and which topics the worker needed but were not
 * delivered. Absent entirely on older/other-form responses; parsing must
 * stay backward compatible (additive-only field, see
 * TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md KP-05).
 */
export interface TaskResultKnowledgeFeedback {
  used?: string[];
  not_used?: string[];
  missing_topics?: string[];
}

/**
 * XP-05 (CROSS_PROVIDER_EXECUTION_PLAN): optional provenance stamp — which
 * reasoning provider/mode actually served the delegation that produced this
 * task_result, and whether that required a failover switch away from the
 * primary candidate. Sourced from `getLastServedReasoningMode()` in
 * reasoning-backend.ts. Additive-only: absent entirely on pre-XP-05
 * task_results, and parsing must stay backward compatible.
 */
export interface TaskResultProvenance {
  provider?: string;
  mode?: string;
  failover?: boolean;
}

export interface TaskResultBlock {
  summary: string;
  artifacts: TaskResultArtifact[];
  verification_done: string[];
  gaps: string[];
  needs: string[];
  acceptance_evidence?: TaskAcceptanceEvidence[];
  review_findings?: TaskReviewFinding[];
  knowledge_feedback?: TaskResultKnowledgeFeedback;
  provenance?: TaskResultProvenance;
}

export interface A2ATaskContext {
  mission_id: string;
  team_role: string;
  execution_mode?: string;
  channel?: string;
  thread?: string;
  slack_channel?: string;
  correlation_id?: string;
  user_language?: string;
  task_model_hint?: Record<string, unknown>;
  model_hint?: Record<string, unknown>;
  // Mission team assignment routing. These are explicit runtime targets,
  // separate from the advisory task_model_hint used for effort selection.
  provider?: string;
  provider_model_id?: string;
  // Set by WorkItem dispatch so runtime results can be attributed to the
  // canonical WorkItem without overloading the mission task id.
  work_item_id?: string;
  // Set by dispatchMissionNextTasks so the worker runtime can attribute the
  // ask to a NEXT_TASKS entry; consumed by the a2a bridge for scoping.
  task_id?: string;
  // Mission task wall-clock budget forwarded to the supervisor-backed ask.
  // This prevents the transport timeout from expiring before the task's own
  // dispatch budget and starting a duplicate fallback ask.
  dispatch_timeout_ms?: number;
  // Kyberion task-contract extension: controls provider-session reuse. The
  // standard A2A contextId remains the conversation continuity identifier.
  context_mode?: AgentContextMode;
  // ContextSecurityScope object from the mission context pack; the a2a bridge
  // uses it to fingerprint conversation storage and validate egress.
  security_scope?: Record<string, unknown>;
  scope?: EventScope;
  // NI-03: root-first DelegationChain (DelegationLink[] — delegation-chain.ts)
  // recording who delegated this task to whom. Typed loosely here like
  // security_scope; delegation-chain.ts's parseDelegationChain is the deep
  // validator. Optional/additive — chain-less contracts are unchanged.
  delegation_chain?: Array<Record<string, unknown>>;
}

export interface A2ATaskContract {
  intent: string;
  text: string;
  context: A2ATaskContext;
  task_model_hint?: Record<string, unknown>;
  objective?: string;
  acceptance_criteria?: string[];
  expected_outputs?: string[];
  rationale?: string;
  prior_decisions?: string[];
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

/**
 * Channels declared by the governed surface-provider manifest.
 * Keep this closed: a new channel must be registered in the manifest and
 * intentionally added here before it can participate in async delivery.
 */
export type SurfaceAsyncChannel =
  | 'slack'
  | 'chronos'
  | 'presence'
  | 'imessage'
  | 'discord'
  | 'telegram'
  | 'cowork'
  | 'cli'
  | 'terminal';

export const SURFACE_ASYNC_CHANNELS: readonly SurfaceAsyncChannel[] = [
  'slack',
  'chronos',
  'presence',
  'imessage',
  'discord',
  'telegram',
  'cowork',
  'cli',
  'terminal',
];

export function isSurfaceAsyncChannel(value: string): value is SurfaceAsyncChannel {
  return (SURFACE_ASYNC_CHANNELS as readonly string[]).includes(value);
}

export interface BaseSurfaceMetadata {
  surface: SurfaceAsyncChannel;
  actorId?: string;
  channel: string;
  threadTs: string;
  scope?: EventScope;
  /** Provider-specific metadata must be narrowed by the provider adapter. */
  [key: string]: unknown;
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

export interface SurfaceConversationAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  uti?: string;
  path?: string;
  size?: number;
}

interface SurfaceConversationInputBase {
  agentId: string;
  query: string;
  senderAgentId: string;
  locale?: SupportedLocale;
  correlationId?: string;
  surfaceText?: string;
  attachments?: SurfaceConversationAttachment[];
  threadContext?: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
  executionFeedback?: ExecutionFeedbackInput;
  scope?: EventScopeInput;
}

export type SurfaceConversationInput = SurfaceConversationInputBase & {
  surface?: SurfaceAsyncChannel;
  surfaceMetadata?: SurfaceConversationMetadata;
};

interface SurfaceConversationMessageInputBase {
  text: string;
  locale?: SupportedLocale;
  surfaceText?: string;
  attachments?: SurfaceConversationAttachment[];
  correlationId?: string;
  messageId?: string;
  receivedAt?: string;
  senderAgentId: string;
  agentId?: string;
  threadContext?: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
  missionId?: string;
  teamRole?: string;
  /** Deterministic local E2E hook; production callers leave this unset. */
  awaitBackgroundReviewFork?: boolean;
  executionFeedback?: ExecutionFeedbackInput;
  scope?: EventScopeInput;
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
  taskResults?: TaskResultBlock[];
  taskResultErrors?: string[];
  taskResultRepairs?: string[];
  taskResultRepairRequiresReview?: boolean;
  surfaceParseErrors?: string[];
  routingDecision?: AgentRoutingDecision;
  intentResolution?: IntentResolutionContract;
  executionFeedbackRequest?: ExecutionFeedbackRequest;
  executionFeedbackRecord?: ExecutionFeedbackRecord;
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
  scope?: EventScope;
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
  scope?: EventScope;
}

export type SurfaceDeliveryErrorKind =
  'too_long' | 'bad_format' | 'forbidden' | 'not_found' | 'rate_limited' | 'transient';

export interface SurfaceDeliveryFailure {
  kind: SurfaceDeliveryErrorKind;
  retryable: boolean;
  reason: string;
  retry_after_ms?: number;
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
  /** Stable producer key used to collapse retries while the outbox record exists. */
  deduplication_key?: string;
  attempt_count?: number;
  next_attempt_at?: string;
  last_error_kind?: SurfaceDeliveryErrorKind;
  last_error?: string;
  scope?: EventScope;
}

export interface SurfaceDeadLetterRecord extends SurfaceOutboxMessage {
  kind: 'surface-dead-letter';
  dead_letter_id: string;
  failure: SurfaceDeliveryFailure;
  dead_lettered_at: string;
  replay_count?: number;
  last_replayed_at?: string;
  last_replay_message_id?: string;
  last_replayed_by?: string;
}

export interface SurfaceDeadTargetRecord {
  surface: SurfaceAsyncChannel;
  channel: string;
  failure: SurfaceDeliveryFailure;
  consecutive_failures: number;
  marked_at: string;
  scope?: EventScope;
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

/** SN-01 Phase 2: surface-neutral pending-proposal state (any ingress surface). */
export interface SurfaceMissionProposalState {
  surface: string;
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
  routingDecision?: AgentRoutingDecision;
  createdAt: string;
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
