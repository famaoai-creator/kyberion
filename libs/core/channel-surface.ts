import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { createApprovalRequest, decideApprovalRequest, loadApprovalRequest, type ApprovalRequestRecord, type ApprovalRequestDraft } from './approval-store.js';
import { appendGovernedArtifactJsonl, ensureGovernedArtifactDir, writeGovernedArtifactJson, type GovernedArtifactRole } from './artifact-store.js';
import { agentLifecycle } from './agent-lifecycle.js';
import { a2aBridge } from './a2a-bridge.js';
import { getAgentManifest } from './agent-manifest.js';

type SurfaceRole = GovernedArtifactRole;

export interface SurfaceConversationResult {
  text: string;
  a2uiMessages: any[];
  a2aMessages: any[];
  delegationResults: any[];
  approvalRequests: SlackApprovalRequestDraft[];
}

interface SurfaceEvent {
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

export interface SlackSurfaceInput {
  user?: string;
  text: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  team?: string;
  channelType?: string;
}

type OnboardingField =
  | 'name'
  | 'language'
  | 'interaction_style'
  | 'primary_domain'
  | 'vision'
  | 'agent_id';

interface OnboardingState {
  channel: string;
  threadTs: string;
  currentField: OnboardingField;
  answers: Partial<Record<OnboardingField, string>>;
  completed: boolean;
  updatedAt: string;
}

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

export interface ChronosSurfaceRequest {
  query: string;
  sessionId?: string;
  requesterId?: string;
}

export interface SurfaceConversationInput {
  agentId: string;
  query: string;
  senderAgentId: string;
  cwd?: string;
  delegationSummaryInstruction?: string;
  forcedReceiver?: string;
}

export interface OnboardingTurnResult {
  replyText: string;
  completed: boolean;
}

export type SlackApprovalRequestDraft = ApprovalRequestDraft;
export type SlackApprovalRequestRecord = ApprovalRequestRecord;

export interface SlackApprovalActionPayload {
  requestId: string;
  decision: 'approved' | 'rejected';
}

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

function withSurfaceRole<T>(role: SurfaceRole, fn: () => T): T {
  const previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = role;
  try {
    return fn();
  } finally {
    if (previousRole === undefined) {
      delete process.env.MISSION_ROLE;
    } else {
      process.env.MISSION_ROLE = previousRole;
    }
  }
}

function ensureDirAs(role: SurfaceRole, logicalPath: string): string {
  return ensureGovernedArtifactDir(role, logicalPath);
}

function appendJsonlAs(role: SurfaceRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function writeJsonAs(role: SurfaceRole, logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson(role, logicalPath, record);
}

export function emitChannelSurfaceEvent(
  role: SurfaceRole,
  channel: string,
  stream: string,
  event: Omit<SurfaceEvent, 'ts' | 'event_id' | 'channel'>
): string {
  return appendJsonlAs(role, `active/shared/observability/channels/${channel}/${stream}.jsonl`, {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel,
    ...event,
  });
}

function emitChronosEvent(stream: string, event: Omit<SurfaceEvent, 'ts' | 'event_id' | 'channel'>): string {
  return appendJsonlAs('chronos_gateway', `active/shared/observability/chronos/${stream}.jsonl`, {
    ts: new Date().toISOString(),
    event_id: randomUUID(),
    channel: 'chronos',
    ...event,
  });
}

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

export function recordSlackSurfaceArtifact(artifact: SlackSurfaceArtifact): string {
  ensureDirAs('slack_bridge', 'active/shared/coordination/channels/slack/inbox');
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'events', {
    correlation_id: artifact.correlationId,
    decision: 'handoff_prepared',
    why: 'Slack Surface Agent normalized conversational input and created a channel-local handoff artifact.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: 'slack-surface-agent',
    resource_id: artifact.stimulus.id,
    thread_context: artifact.stimulus.origin.context,
  });
  return writeJsonAs('slack_bridge', artifact.inboxPath, artifact);
}

export function recordChronosSurfaceRequest(input: ChronosSurfaceRequest): string {
  const correlationId = randomUUID();
  const sessionId = input.sessionId || 'default';
  ensureDirAs('chronos_gateway', `active/shared/coordination/chronos/sessions/${sessionId}`);

  const artifact = {
    ts: new Date().toISOString(),
    correlation_id: correlationId,
    session_id: sessionId,
    requester_id: input.requesterId || 'unknown',
    query: input.query,
    agent_id: 'chronos-surface-agent',
  };

  emitChronosEvent('requests', {
    correlation_id: correlationId,
    decision: 'request_received',
    why: 'Chronos Surface Agent accepted an authenticated control request and prepared runtime routing state.',
    policy_used: 'chronos_surface_agent_v1',
    agent_id: 'chronos-surface-agent',
    resource_id: sessionId,
  });

  return writeJsonAs(
    'chronos_gateway',
    `active/shared/coordination/chronos/sessions/${sessionId}/${correlationId}.json`,
    artifact
  );
}

export function recordChronosDelegationSummary(
  correlationId: string,
  delegationCount: number,
  delegatedAgents: string[]
): string {
  return emitChronosEvent('delegations', {
    correlation_id: correlationId,
    decision: 'delegation_processed',
    why: 'Chronos Surface Agent recorded A2A delegation activity for explainable control-plane tracing.',
    policy_used: 'chronos_surface_agent_v1',
    agent_id: 'chronos-surface-agent',
    resource_id: delegatedAgents.join(','),
    delegation_count: delegationCount,
  });
}

export function extractSurfaceBlocks(raw: string): SurfaceConversationResult {
  const a2uiMessages: any[] = [];
  const a2aMessages: any[] = [];
  const approvalRequests: SlackApprovalRequestDraft[] = [];

  let text = raw;

  text = text.replace(/```a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  text = text.replace(/```\s*a2ui\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2uiMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  text = text.replace(/```a2a\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  text = text.replace(/```approval\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { approvalRequests.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  text = text.replace(/>>A2A(\{[\s\S]*?\})<</g, (_match, json) => {
    try { a2aMessages.push(JSON.parse(json.trim())); } catch (_) {}
    return '';
  });

  return {
    text: text.trim(),
    a2uiMessages,
    a2aMessages,
    delegationResults: [],
    approvalRequests,
  };
}

async function ensureSurfaceAgent(agentId: string, cwd?: string) {
  const existing = agentLifecycle.getHandle(agentId);
  const status = existing?.getRecord?.()?.status;
  if (existing && status !== 'shutdown' && status !== 'error') return existing;

  const manifest = getAgentManifest(agentId, pathResolver.rootDir());
  if (!manifest) {
    throw new Error(`Surface agent manifest not found: ${agentId}`);
  }

  return agentLifecycle.spawn({
    agentId,
    provider: manifest.provider,
    modelId: manifest.modelId,
    systemPrompt: manifest.systemPrompt,
    capabilities: manifest.capabilities,
    cwd: cwd || pathResolver.rootDir(),
  });
}

async function processDelegations(a2aMessages: any[], senderAgentId: string): Promise<any[]> {
  const delegationResults: any[] = [];

  for (const msg of a2aMessages) {
    try {
      const envelope = {
        a2a_version: '1.0',
        header: {
          msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`,
          sender: senderAgentId,
          receiver: msg.header?.receiver,
          performative: msg.header?.performative || 'request',
          conversation_id: msg.header?.conversation_id,
          timestamp: new Date().toISOString(),
        },
        payload: msg.payload,
      };

      const response = await a2aBridge.route(envelope);
      delegationResults.push({
        receiver: envelope.header.receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
      });
    } catch (err: any) {
      delegationResults.push({
        receiver: msg.header?.receiver,
        error: err.message,
      });
    }
  }

  return delegationResults;
}

async function routeForcedDelegation(receiver: string, query: string, senderAgentId: string): Promise<any[]> {
  try {
    const response = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`,
        sender: senderAgentId,
        receiver,
        performative: 'request',
        timestamp: new Date().toISOString(),
      },
      payload: {
        intent: 'surface_handoff',
        text: query,
      },
    });

    return [{
      receiver,
      response: response.payload?.text || JSON.stringify(response.payload),
    }];
  } catch (err: any) {
    return [{
      receiver,
      error: err.message,
    }];
  }
}

export async function runSurfaceConversation(input: SurfaceConversationInput): Promise<SurfaceConversationResult> {
  const handle = await ensureSurfaceAgent(input.agentId, input.cwd);
  const firstResponse = await handle.ask(input.query);
  const firstBlocks = extractSurfaceBlocks(firstResponse);
  const delegationResults = firstBlocks.a2aMessages.length > 0
    ? await processDelegations(firstBlocks.a2aMessages, input.senderAgentId)
    : input.forcedReceiver
      ? await routeForcedDelegation(input.forcedReceiver, input.query, input.senderAgentId)
      : [];

  if (delegationResults.length === 0) {
    return firstBlocks;
  }

  const successful = delegationResults.filter((result) => !result.error);

  if (successful.length === 0) {
    return {
      ...firstBlocks,
      delegationResults,
      approvalRequests: firstBlocks.approvalRequests,
    };
  }

  const summaryContext = successful
    .map((result) => `[Response from ${result.receiver}]: ${result.response}`)
    .join('\n\n');

  const summaryInstruction =
    input.delegationSummaryInstruction ||
    'Below are delegated responses. Produce the final user-facing answer for the original request. Do not emit any A2A blocks.';

  const summaryPrompt = `${summaryInstruction}\n\n${summaryContext}`;

  const followUpResponse = await handle.ask(summaryPrompt);
  const followUpBlocks = extractSurfaceBlocks(followUpResponse);

  return {
    text: followUpBlocks.text,
    a2uiMessages: [...firstBlocks.a2uiMessages, ...followUpBlocks.a2uiMessages],
    a2aMessages: firstBlocks.a2aMessages,
    delegationResults,
    approvalRequests: [...firstBlocks.approvalRequests, ...followUpBlocks.approvalRequests],
  };
}

export function buildSlackSurfacePrompt(input: SlackSurfaceInput): string {
  const threadTs = input.threadTs || input.ts || 'unknown';
  const channelType = input.channelType || 'unknown';
  return [
    'You are handling a Slack conversation as the Slack Surface Agent.',
    `Channel: ${input.channel}`,
    `Thread: ${threadTs}`,
    `Channel type: ${channelType}`,
    `User: ${input.user || 'unknown'}`,
    '',
    'User message:',
    input.text.trim(),
  ].join('\n');
}

export function shouldForceSlackDelegation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const lightweightPatterns = [
    /^ping[!.?]?$/,
    /^test[!.?]?$/,
    /^hello[!.?]?$/,
    /^hi[!.?]?$/,
    /^thanks?[!.?]?$/,
    /^ありがとう[。！!]?$/,
    /^了解です?[。！!]?$/,
    /^ok[!.?]?$/,
  ];

  return !lightweightPatterns.some((pattern) => pattern.test(normalized));
}

export function recordSlackDelivery(correlationId: string, channel: string, threadTs: string, deliveryTs?: string): string {
  return emitChannelSurfaceEvent('slack_bridge', 'slack', 'deliveries', {
    correlation_id: correlationId,
    decision: 'delivery_sent',
    why: 'Slack Surface Agent response was delivered back to the originating Slack thread.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: 'slack-surface-agent',
    resource_id: deliveryTs || threadTs,
    slack_channel: channel,
    thread_ts: threadTs,
  });
}

export function createSlackApprovalRequest(params: {
  channel: string;
  threadTs: string;
  correlationId: string;
  requestedBy: string;
  draft: SlackApprovalRequestDraft;
  sourceText?: string;
}): SlackApprovalRequestRecord {
  const record = createApprovalRequest('slack_bridge', {
    channel: params.channel,
    storageChannel: 'slack',
    threadTs: params.threadTs,
    correlationId: params.correlationId,
    requestedBy: params.requestedBy,
    draft: params.draft,
    sourceText: params.sourceText,
  });
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'approvals', {
    correlation_id: params.correlationId,
    decision: 'approval_requested',
    why: 'Surface flow requested explicit human approval before continuing execution.',
    policy_used: 'slack_approval_ui_v1',
    agent_id: params.requestedBy,
    resource_id: record.id,
    thread_ts: params.threadTs,
    slack_channel: params.channel,
  });
  return record;
}

export function loadSlackApprovalRequest(id: string): SlackApprovalRequestRecord | null {
  return loadApprovalRequest('slack', id);
}

export function buildSlackApprovalBlocks(record: SlackApprovalRequestRecord): any[] {
  const severity = record.severity || 'medium';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Approval Required*\n*${record.title}*\n${record.summary}`,
      },
    },
    ...(record.details
      ? [{
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Details: ${record.details}`,
            },
          ],
        }]
      : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Severity: ${severity} | Status: ${record.status}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({ requestId: record.id, decision: 'approved' satisfies SlackApprovalActionPayload['decision'] }),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Reject' },
          action_id: 'slack_approval_decide',
          value: JSON.stringify({ requestId: record.id, decision: 'rejected' satisfies SlackApprovalActionPayload['decision'] }),
        },
      ],
    },
  ];
}

export function parseSlackApprovalAction(value: string): SlackApprovalActionPayload {
  return JSON.parse(value) as SlackApprovalActionPayload;
}

export function applySlackApprovalDecision(params: {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
}): SlackApprovalRequestRecord {
  const updated = decideApprovalRequest('slack_bridge', {
    channel: 'slack',
    storageChannel: 'slack',
    requestId: params.requestId,
    decision: params.decision,
    decidedBy: params.decidedBy,
  });
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'approvals', {
    correlation_id: updated.correlationId,
    decision: params.decision,
    why: 'A human decision was captured from the Slack approval card.',
    policy_used: 'slack_approval_ui_v1',
    agent_id: updated.requestedBy,
    resource_id: updated.id,
    thread_ts: updated.threadTs,
    slack_channel: updated.channel,
    decided_by: params.decidedBy,
  });
  return updated;
}

function onboardingStateLogicalPath(channel: string, threadTs: string): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `active/shared/coordination/channels/slack/onboarding/${channel}-${safeThread}.json`;
}

function onboardingQuestions(): Record<OnboardingField, string> {
  return {
    name: 'まず、どのようにお呼びすれば良いですか？',
    language: '普段のやり取りで使いたい言語を教えてください。例: Japanese / English',
    interaction_style: '対話スタイルはどうしますか？ Senior Partner / Concierge / Minimalist から選んでください。',
    primary_domain: '主な活動領域を教えてください。例: Software Engineering / Data Analysis / Writing',
    vision: 'この環境で実現したい vision を短く教えてください。',
    agent_id: '最後に、この環境のメイン Agent ID を決めます。希望名があれば教えてください。既定値を使う場合は「そのまま」「default」「おまかせ」のいずれかを送ってください。既定値は KYBERION-PRIME です。',
  };
}

const TEXT_MODAL_FIELDS: OnboardingField[] = ['name', 'primary_domain', 'vision'];

function onboardingFieldTitle(field: OnboardingField): string {
  switch (field) {
    case 'name':
      return 'Sovereign Name';
    case 'language':
      return 'Language';
    case 'interaction_style':
      return 'Interaction Style';
    case 'primary_domain':
      return 'Primary Domain';
    case 'vision':
      return 'Vision';
    case 'agent_id':
      return 'Agent ID';
  }
}

function nextOnboardingField(field: OnboardingField): OnboardingField | null {
  const order: OnboardingField[] = ['name', 'language', 'interaction_style', 'primary_domain', 'vision', 'agent_id'];
  const index = order.indexOf(field);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : null;
}

function currentOnboardingField(state: OnboardingState | null): OnboardingField {
  return state?.currentField || 'name';
}

export function isEnvironmentInitialized(): boolean {
  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  const visionPath = pathResolver.knowledge('personal/my-vision.md');
  const agentIdentityPath = pathResolver.knowledge('personal/agent-identity.json');
  return safeExistsSync(identityPath) && safeExistsSync(visionPath) && safeExistsSync(agentIdentityPath);
}

function loadOnboardingState(channel: string, threadTs: string): OnboardingState | null {
  const logicalPath = onboardingStateLogicalPath(channel, threadTs);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as OnboardingState;
}

export function getSlackOnboardingState(channel: string, threadTs: string): OnboardingState | null {
  return loadOnboardingState(channel, threadTs);
}

function saveOnboardingState(state: OnboardingState): string {
  return writeJsonAs('slack_bridge', onboardingStateLogicalPath(state.channel, state.threadTs), state);
}

function normalizeInteractionStyle(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.startsWith('s')) return 'Senior Partner';
  if (value.startsWith('m')) return 'Minimalist';
  if (value.startsWith('c')) return 'Concierge';
  return input.trim() || 'Concierge';
}

function shouldUseDefaultAgentId(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return true;

  const defaultPatterns = [
    /^default$/,
    /^skip$/,
    /^use default$/,
    /^そのまま$/,
    /^おまかせ$/,
    /^任せます$/,
    /^既定値$/,
    /^デフォルト$/,
    /^デフォルトで$/,
    /^その名前で.*$/,
    /^いただいた名前で.*$/,
    /^それで大丈夫.*$/,
  ];

  return defaultPatterns.some((pattern) => pattern.test(normalized));
}

function normalizeOnboardingAnswer(field: OnboardingField, input: string): string {
  const trimmed = input.trim();
  if (field === 'agent_id' && shouldUseDefaultAgentId(trimmed)) {
    return 'KYBERION-PRIME';
  }
  return trimmed;
}

function serializeOnboardingAction(payload: SlackOnboardingActionPayload): string {
  return JSON.stringify(payload);
}

export function parseSlackOnboardingAction(value: string): SlackOnboardingActionPayload {
  return JSON.parse(value) as SlackOnboardingActionPayload;
}

export function buildSlackOnboardingPrompt(channel: string, threadTs: string): SlackOnboardingPrompt {
  const state = loadOnboardingState(channel, threadTs);
  const field = currentOnboardingField(state);
  return {
    field,
    text: onboardingQuestions()[field],
  };
}

export function buildSlackOnboardingBlocks(channel: string, threadTs: string): any[] {
  const prompt = buildSlackOnboardingPrompt(channel, threadTs);
  const state = loadOnboardingState(channel, threadTs);
  const answer = state?.answers?.[prompt.field] || '';

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Onboarding*\n${prompt.text}`,
      },
    },
  ];

  if (prompt.field === 'language') {
    blocks.push({
      type: 'actions',
      elements: ['日本語', 'English'].map((label) => ({
        type: 'button',
        text: { type: 'plain_text', text: label },
        action_id: 'slack_onboarding_pick',
        value: serializeOnboardingAction({
          channel,
          threadTs,
          field: prompt.field,
          answer: label,
        }),
      })),
    });
    return blocks;
  }

  if (prompt.field === 'interaction_style') {
    blocks.push({
      type: 'actions',
      elements: ['Senior Partner', 'Concierge', 'Minimalist'].map((label) => ({
        type: 'button',
        text: { type: 'plain_text', text: label },
        action_id: 'slack_onboarding_pick',
        value: serializeOnboardingAction({
          channel,
          threadTs,
          field: prompt.field,
          answer: label,
        }),
      })),
    });
    return blocks;
  }

  if (prompt.field === 'agent_id') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Use KYBERION-PRIME' },
          style: 'primary',
          action_id: 'slack_onboarding_pick',
          value: serializeOnboardingAction({
            channel,
            threadTs,
            field: prompt.field,
            answer: 'default',
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Set custom Agent ID' },
          action_id: 'slack_onboarding_open_modal',
          value: serializeOnboardingAction({
            channel,
            threadTs,
            field: prompt.field,
          }),
        },
      ],
    });
    return blocks;
  }

  if (TEXT_MODAL_FIELDS.includes(prompt.field)) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open input form' },
          style: 'primary',
          action_id: 'slack_onboarding_open_modal',
          value: serializeOnboardingAction({
            channel,
            threadTs,
            field: prompt.field,
          }),
        },
      ],
    });
    if (answer) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Current value: ${answer}`,
          },
        ],
      });
    }
  }

  return blocks;
}

export function buildSlackOnboardingModal(payload: SlackOnboardingActionPayload): any {
  const existing = loadOnboardingState(payload.channel, payload.threadTs);
  const currentValue = existing?.answers?.[payload.field] || '';
  const question = onboardingQuestions()[payload.field];

  return {
    type: 'modal',
    callback_id: 'slack_onboarding_submit',
    private_metadata: JSON.stringify(payload),
    title: {
      type: 'plain_text',
      text: onboardingFieldTitle(payload.field),
    },
    submit: {
      type: 'plain_text',
      text: 'Save',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    blocks: [
      {
        type: 'input',
        block_id: 'slack_onboarding_input',
        label: {
          type: 'plain_text',
          text: onboardingFieldTitle(payload.field),
        },
        hint: {
          type: 'plain_text',
          text: question,
        },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: payload.field === 'vision' || payload.field === 'primary_domain',
          initial_value: currentValue,
        },
      },
    ],
  };
}

function persistOnboardingIdentity(state: OnboardingState): void {
  const name = state.answers.name || 'Sovereign';
  const language = state.answers.language || 'Japanese';
  const interactionStyle = normalizeInteractionStyle(state.answers.interaction_style || 'Concierge');
  const primaryDomain = state.answers.primary_domain || 'General';
  const vision = state.answers.vision || 'Build a high-fidelity Kyberion environment.';
  const agentId = (state.answers.agent_id || 'KYBERION-PRIME').trim().toUpperCase();
  const now = new Date().toISOString();

  withSurfaceRole('sovereign_concierge', () => {
    safeMkdir(pathResolver.knowledge('personal'), { recursive: true });
    safeWriteFile(pathResolver.knowledge('personal/my-identity.json'), JSON.stringify({
      name,
      language,
      interaction_style: interactionStyle,
      primary_domain: primaryDomain,
      created_at: now,
      status: 'active',
      version: '1.0.0',
    }, null, 2));
    safeWriteFile(pathResolver.knowledge('personal/my-vision.md'), `# Sovereign Vision\n\n${vision}\n`);
    safeWriteFile(pathResolver.knowledge('personal/agent-identity.json'), JSON.stringify({
      agent_id: agentId,
      version: '1.0.0',
      role: 'Ecosystem Architect / Senior Partner',
      owner: name,
      trust_tier: 'sovereign',
      created_at: now,
      description: `The primary autonomous entity of the Kyberion Ecosystem for ${name}.`,
    }, null, 2));
  });
}

export function handleSlackOnboardingTurn(params: {
  channel: string;
  threadTs: string;
  text: string;
}): OnboardingTurnResult {
  const questions = onboardingQuestions();
  let state = loadOnboardingState(params.channel, params.threadTs);

  if (!state) {
    state = {
      channel: params.channel,
      threadTs: params.threadTs,
      currentField: 'name',
      answers: {},
      completed: false,
      updatedAt: new Date().toISOString(),
    };
    saveOnboardingState(state);
    return {
      completed: false,
      replyText: [
        'この環境はまだ初期化されていないため、まずオンボーディングを進めます。',
        '1問ずつ確認していきます。',
        '',
        questions.name,
      ].join('\n'),
    };
  }

  if (!state.completed) {
    state.answers[state.currentField] = normalizeOnboardingAnswer(state.currentField, params.text);
    const nextField = nextOnboardingField(state.currentField);
    state.updatedAt = new Date().toISOString();

    if (!nextField) {
      state.completed = true;
      saveOnboardingState(state);
      persistOnboardingIdentity(state);
      return {
        completed: true,
        replyText: [
          'オンボーディング情報を保存しました。',
          `Name: ${state.answers.name}`,
          `Language: ${state.answers.language}`,
          `Style: ${normalizeInteractionStyle(state.answers.interaction_style || 'Concierge')}`,
          `Domain: ${state.answers.primary_domain}`,
          `Agent ID: ${(state.answers.agent_id || 'KYBERION-PRIME').trim().toUpperCase()}`,
          '',
          '初期化が完了したので、次のメッセージから通常の routing に切り替えます。',
        ].join('\n'),
      };
    }

    state.currentField = nextField;
    saveOnboardingState(state);
    return {
      completed: false,
      replyText: questions[nextField],
    };
  }

  return {
    completed: true,
    replyText: 'オンボーディングは完了しています。通常の依頼を送ってください。',
  };
}
