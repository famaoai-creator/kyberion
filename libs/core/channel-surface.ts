import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExec, safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeRmSync, safeWriteFile } from './secure-io.js';
import { enqueueMissionOrchestrationEvent, startMissionOrchestrationWorker } from './mission-orchestration-events.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from './agent-runtime-supervisor.js';
import {
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import { createApprovalRequest, decideApprovalRequest, loadApprovalRequest, type ApprovalRequestRecord, type ApprovalRequestDraft } from './approval-store.js';
import { appendGovernedArtifactJsonl, ensureGovernedArtifactDir, writeGovernedArtifactJson, type GovernedArtifactRole } from './artifact-store.js';
import { a2aBridge } from './a2a-bridge.js';
import { getAgentManifest } from './agent-manifest.js';
import { buildMissionTeamView, loadMissionTeamPlan, resolveMissionTeamReceiver } from './mission-team-composer.js';
import { buildExecutionEnv, withExecutionContext } from './authority.js';
import { compileUserIntentFlow, formatClarificationPacket, type UserIntentFlow } from './intent-contract.js';
import { logger } from './core.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

import type {
  SurfaceRole,
  SurfaceEvent,
  SlackSurfaceInput,
  SlackExecutionMode,
  SlackSurfaceArtifact,
  ChronosSurfaceRequest,
  SurfaceConversationInput,
  SurfaceConversationResult,
  NerveRoutingProposal,
  MissionProposal,
  PlanningPacketTask,
  PlanningPacket,
  SurfaceAsyncRequestRecord,
  SurfaceNotificationRecord,
  SurfaceOutboxMessage,
  SlackMissionIssuanceResult,
  SlackApprovalActionPayload,
  OnboardingField,
  SlackOnboardingPrompt,
  SlackOnboardingActionPayload,
  OnboardingTurnResult,
  // Internal state types
  ParsedSlackSurfacePrompt,
  OnboardingState,
  SlackMissionProposalState,
  ChronosMissionProposalState,
  // Internal aliases
  SlackOutboxMessage,
  SlackApprovalRequestDraft,
  SlackApprovalRequestRecord,
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

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SURFACE_POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/surface-policy.schema.json');

type SurfaceDelegationReceiver = 'chronos-mirror' | 'nerve-agent';

interface SurfaceRuntimeRouteContext {
  input: SurfaceConversationInput;
  compiledFlow: UserIntentFlow | null;
  computedReceiver?: SurfaceDelegationReceiver;
  structuredQuery: string;
  parsedSlackPrompt: ParsedSlackSurfacePrompt | null;
}

interface SurfaceRuntimeRouteHandler {
  matches: (context: SurfaceRuntimeRouteContext) => boolean;
  handle: (context: SurfaceRuntimeRouteContext) => Promise<SurfaceConversationResult>;
}

interface SurfaceReceiverRule {
  receiver: SurfaceDelegationReceiver;
  when: (flow: UserIntentFlow) => boolean;
}

interface SurfaceRoutingRulesFile {
  text_routing?: {
    greeting_patterns?: Array<TextMatchRule | string>;
    receiver_rules?: Array<{
      id?: string;
      receiver?: SurfaceDelegationReceiver;
      patterns?: Array<TextMatchRule | string>;
    }>;
  };
  compiled_flow_rules?: Array<{
    id?: string;
    receiver?: SurfaceDelegationReceiver;
    execution_shapes?: string[];
    conversation_agents?: string[];
    task_types?: string[];
  }>;
}

interface SlackIntentRulesFile {
  version: string;
  rules?: Array<{
    id?: string;
    label?: string;
    patterns?: Array<TextMatchRule | string>;
  }>;
  default_label: string;
}

interface SlackSurfaceRulesFile {
  version: string;
  execution_mode: {
    feasibility_patterns: Array<TextMatchRule | string>;
    durable_task_patterns: Array<TextMatchRule | string>;
  };
  delegation: {
    lightweight_patterns: Array<TextMatchRule | string>;
  };
}

interface SurfacePolicyFile {
  version: string;
  routing: SurfaceRoutingRulesFile;
  slack: {
    intent_rules: SlackIntentRulesFile;
    surface_rules: SlackSurfaceRulesFile;
  };
}

let surfacePolicyValidateFn: ValidateFunction | null = null;

function ensureSurfacePolicyValidator(): ValidateFunction {
  if (surfacePolicyValidateFn) return surfacePolicyValidateFn;
  surfacePolicyValidateFn = compileSchemaFromPath(ajv, SURFACE_POLICY_SCHEMA_PATH);
  return surfacePolicyValidateFn;
}


function withSurfaceRole<T>(role: SurfaceRole, fn: () => T): T {
  return withExecutionContext(role, fn);
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

function loadSurfacePolicy(): SurfacePolicyFile {
  const value = JSON.parse(
    safeReadFile(pathResolver.knowledge('public/governance/surface-policy.json'), { encoding: 'utf8' }) as string,
  ) as SurfacePolicyFile;
  const validate = ensureSurfacePolicyValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid surface policy: ${errors}`);
  }
  return value;
}

function loadSurfaceRoutingRules(): SurfaceRoutingRulesFile {
  return loadSurfacePolicy().routing;
}

function loadSlackIntentRules(): SlackIntentRulesFile {
  return loadSurfacePolicy().slack.intent_rules;
}

function loadSlackSurfaceRules(): SlackSurfaceRulesFile {
  return loadSurfacePolicy().slack.surface_rules;
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
  const routingProposals: NerveRoutingProposal[] = [];
  const missionProposals: MissionProposal[] = [];
  const planningPackets: PlanningPacket[] = [];

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

  text = text.replace(/```(?:nerve_route|route)\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { routingProposals.push(JSON.parse(json.trim()) as NerveRoutingProposal); } catch (_) {}
    return '';
  });

  text = text.replace(/```mission_proposal\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { missionProposals.push(JSON.parse(json.trim()) as MissionProposal); } catch (_) {}
    return '';
  });

  text = text.replace(/```planning_packet\s*\n([\s\S]*?)```/g, (_match, json) => {
    try { planningPackets.push(JSON.parse(json.trim()) as PlanningPacket); } catch (_) {}
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
    routingProposals,
    missionProposals,
    planningPackets,
  };
}

function buildMissionTeamPromptContext(missionId: string): string {
  const plan = loadMissionTeamPlan(missionId);
  if (!plan) return '';
  const teamView = buildMissionTeamView(plan);
  return [
    '',
    'Mission team context:',
    JSON.stringify({
      mission_id: plan.mission_id,
      mission_type: plan.mission_type,
      team: teamView,
    }, null, 2),
    '',
    'If delegation is needed, choose a team_role from the team object and emit a ```nerve_route``` JSON block.',
  ].join('\n');
}

async function ensureSurfaceAgent(agentId: string, cwd?: string) {
  const existing = getAgentRuntimeHandle(agentId);
  const status = existing?.getRecord?.()?.status;
  if (existing && status !== 'shutdown' && status !== 'error') return existing;

  const manifest = getAgentManifest(agentId, pathResolver.rootDir());
  if (!manifest) {
    throw new Error(`Surface agent manifest not found: ${agentId}`);
  }

  const spawnOptions = {
    agentId,
    provider: manifest.provider,
    modelId: manifest.modelId,
    systemPrompt: manifest.systemPrompt,
    capabilities: manifest.capabilities,
    cwd: cwd || pathResolver.rootDir(),
    requestedBy: 'surface_agent',
    runtimeOwnerId: agentId,
    runtimeOwnerType: 'surface',
    runtimeMetadata: {
      lease_kind: 'surface',
      surface_agent_id: agentId,
    },
  } as const;

  if (process.env.KYBERION_DISABLE_AGENT_RUNTIME_SUPERVISOR_DAEMON === '1') {
    return ensureAgentRuntime(spawnOptions);
  }

  try {
    const snapshot = await ensureAgentRuntimeViaDaemon(
      toSupervisorEnsurePayload(spawnOptions),
    );
    return createSupervisorBackedAgentHandle(agentId, spawnOptions.requestedBy, snapshot);
  } catch (_) {
    return ensureAgentRuntime(spawnOptions);
  }
}

function buildDelegationFallbackText(query: string): string {
  const marker = 'User message:\n';
  const idx = query.lastIndexOf(marker);
  if (idx >= 0) {
    const extracted = query.slice(idx + marker.length).trim();
    if (extracted) return extracted;
  }
  return query.trim();
}

function parseSlackSurfacePrompt(query: string): ParsedSlackSurfacePrompt | null {
  if (!query.includes('You are handling a Slack conversation as the Slack Surface Agent.')) {
    return null;
  }

  const readLine = (label: string): string | undefined => {
    const match = query.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim();
  };

  const userMessage = buildDelegationFallbackText(query);
  return {
    channel: readLine('Channel'),
    thread: readLine('Thread'),
    user: readLine('User'),
    derivedLanguage: readLine('Derived language'),
    executionMode: readLine('Execution mode') as SlackExecutionMode | undefined,
    userMessage,
  };
}

export function deriveSlackIntentLabel(text: string): string {
  const normalized = text.trim();
  if (!normalized) return 'general_request';
  const rules = loadSlackIntentRules();
  const matchedRule = (rules.rules || []).find((rule) => matchesAnyTextRule(normalized, rule.patterns));
  return matchedRule?.label || rules.default_label || 'request_deeper_reasoning';
}

export function deriveSurfaceDelegationReceiver(text: string): 'chronos-mirror' | 'nerve-agent' | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;

  const rules = loadSurfaceRoutingRules();
  if (matchesAnyTextRule(normalized, rules.text_routing?.greeting_patterns)) {
    return undefined;
  }
  const matchedRule = (rules.text_routing?.receiver_rules || []).find((rule) =>
    matchesAnyTextRule(normalized, rule.patterns),
  );
  return matchedRule?.receiver;
}

export function deriveSlackDelegationReceiver(text: string): 'chronos-mirror' | 'nerve-agent' | undefined {
  return deriveSurfaceDelegationReceiver(text);
}

function normalizeSurfaceDelegationReceiver(value?: string): SurfaceDelegationReceiver | undefined {
  return value === 'chronos-mirror' || value === 'nerve-agent' ? value : undefined;
}

function buildSurfaceReceiverRules(): SurfaceReceiverRule[] {
  const rules = loadSurfaceRoutingRules();
  return (rules.compiled_flow_rules || [])
    .filter((rule): rule is NonNullable<SurfaceRoutingRulesFile['compiled_flow_rules']>[number] & { receiver: SurfaceDelegationReceiver } => Boolean(rule?.receiver))
    .map((rule) => ({
      receiver: rule.receiver,
      when: (flow: UserIntentFlow) => {
        const executionShape = flow.intentContract.resolution.execution_shape;
        const conversationAgent = flow.workLoop.teaming.conversation_agent;
        const taskType = flow.workLoop.resolution.task_type;
        return Boolean(
          (rule.execution_shapes || []).includes(executionShape) ||
          (conversationAgent && (rule.conversation_agents || []).includes(conversationAgent)) ||
          (taskType && (rule.task_types || []).includes(taskType)),
        );
      },
    }));
}

export function resolveSurfaceConversationReceiver(
  forcedReceiver?: SurfaceDelegationReceiver,
  compiledFlow?: UserIntentFlow | null,
): SurfaceDelegationReceiver | undefined {
  if (forcedReceiver) return forcedReceiver;
  if (!compiledFlow) return undefined;
  const surfaceReceiverRules = buildSurfaceReceiverRules();
  return surfaceReceiverRules.find((rule) => rule.when(compiledFlow))?.receiver;
}

function normalizeDelegationPayload(payload: any, fallbackText: string): any {
  if (!payload || typeof payload !== 'object') return payload;
  const currentText = typeof payload.text === 'string' ? payload.text.trim() : '';
  const looksPlaceholder =
    currentText === '' ||
    currentText === 'original request and relevant Slack context' ||
    currentText === 'original request';

  if (!looksPlaceholder) return payload;
  return {
    ...payload,
    text: fallbackText,
  };
}

async function processDelegations(a2aMessages: any[], senderAgentId: string, fallbackText: string): Promise<any[]> {
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
        payload: normalizeDelegationPayload(msg.payload, fallbackText),
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

async function routeForcedDelegation(
  receiver: string,
  query: string,
  senderAgentId: string,
  missionId?: string,
): Promise<any[]> {
  try {
    const enrichedQuery = receiver === 'nerve-agent' && missionId
      ? `${query}\n${buildMissionTeamPromptContext(missionId)}`
      : query;
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
        text: enrichedQuery,
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

async function routeSlackForcedDelegation(
  receiver: string,
  query: string,
  senderAgentId: string,
  missionId?: string,
): Promise<any[]> {
  const parsed = parseSlackSurfacePrompt(query);
  if (!parsed) {
    return routeForcedDelegation(receiver, query, senderAgentId, missionId);
  }

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
        intent: deriveSlackIntentLabel(parsed.userMessage),
        text: parsed.userMessage,
        context: {
          channel: 'slack',
          slack_channel: parsed.channel,
          thread: parsed.thread,
          user: parsed.user,
          user_language: parsed.derivedLanguage,
          execution_mode: parsed.executionMode || 'conversation',
        },
      },
    });

    return [{
      receiver,
      response: response.payload?.text || JSON.stringify(response.payload),
      bypassedSurfaceAgent: true,
    }];
  } catch (err: any) {
    return [{
      receiver,
      error: err.message,
      bypassedSurfaceAgent: true,
    }];
  }
}

async function routeMissionTeamDelegation(
  missionId: string,
  teamRole: string,
  query: string,
  senderAgentId: string,
): Promise<any[]> {
  const assignment = resolveMissionTeamReceiver({ missionId, teamRole });
  if (!assignment?.agent_id) {
    return [{
      receiver: `${missionId}:${teamRole}`,
      error: `No assigned agent for team role ${teamRole} in mission ${missionId}`,
    }];
  }

  const results = await routeForcedDelegation(assignment.agent_id, query, senderAgentId, missionId);
  return results.map((result) => ({
    ...result,
    missionId,
    teamRole,
    authorityRole: assignment.authority_role,
  }));
}

async function routeNerveRoutingProposals(
  proposals: NerveRoutingProposal[],
  senderAgentId: string,
  missionId?: string,
): Promise<any[]> {
  if (!missionId) return [];
  const results: any[] = [];
  for (const proposal of proposals) {
    if (proposal.intent !== 'delegate_task' || !proposal.team_role) continue;
    const delegated = await routeMissionTeamDelegation(
      proposal.mission_id || missionId,
      proposal.team_role,
      proposal.task_summary || proposal.why || 'Delegated task from nerve-agent',
      senderAgentId,
    );
    results.push(...delegated);
  }
  return results;
}

async function handleSlackConversationBypass(context: SurfaceRuntimeRouteContext): Promise<SurfaceConversationResult> {
  const delegationResults = await routeSlackForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.input.missionId,
  );
  const successful = delegationResults.filter((result) => !result.error);
  const firstResponse = successful[0]?.response || '';
  const parsed = extractSurfaceBlocks(firstResponse);
  return {
    text: firstResponse,
    a2uiMessages: [],
    a2aMessages: [],
    delegationResults,
    approvalRequests: [],
    routingProposals: [],
    missionProposals: parsed.missionProposals || [],
    planningPackets: parsed.planningPackets || [],
  };
}

async function handlePresenceForcedBypass(context: SurfaceRuntimeRouteContext): Promise<SurfaceConversationResult> {
  const delegationResults = await routeForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.input.missionId,
  );
  const successful = delegationResults.filter((result) => !result.error);
  const firstResponse = successful[0]?.response || '';
  const parsed = extractSurfaceBlocks(firstResponse);
  return {
    text: firstResponse,
    a2uiMessages: [],
    a2aMessages: [],
    delegationResults,
    approvalRequests: [],
    routingProposals: [],
    missionProposals: parsed.missionProposals || [],
    planningPackets: parsed.planningPackets || [],
  };
}

const SURFACE_RUNTIME_ROUTE_HANDLERS: SurfaceRuntimeRouteHandler[] = [
  {
    matches: (context) => Boolean(context.parsedSlackPrompt && context.parsedSlackPrompt.executionMode === 'conversation' && context.computedReceiver),
    handle: handleSlackConversationBypass,
  },
  {
    matches: (context) => context.input.agentId === 'presence-surface-agent' && Boolean(context.computedReceiver),
    handle: handlePresenceForcedBypass,
  },
];

export async function runSurfaceConversation(input: SurfaceConversationInput): Promise<SurfaceConversationResult> {
  const forcedReceiver = normalizeSurfaceDelegationReceiver(input.forcedReceiver);
  const compiledFlow = input.forcedReceiver
    ? null
    : await compileUserIntentFlow({
      text: input.query,
      channel: input.agentId.includes('slack') ? 'slack' : input.agentId.includes('presence') ? 'presence' : 'surface',
    }).catch((error: any) => {
      logger.warn(`[SURFACE] Intent contract compilation failed: ${error?.message || String(error)}`);
      return null;
    });

  if (compiledFlow?.clarificationPacket) {
    return {
      text: formatClarificationPacket(compiledFlow.clarificationPacket),
      a2uiMessages: [],
      a2aMessages: [],
      delegationResults: [],
      approvalRequests: [],
      routingProposals: [],
      missionProposals: [],
      planningPackets: [],
    };
  }

  const computedReceiver = !forcedReceiver && compiledFlow
    ? resolveSurfaceConversationReceiver(undefined, compiledFlow)
    : forcedReceiver;

  const structuredQuery = compiledFlow
    ? [
      input.query,
      '',
      'Governed intent contract:',
      JSON.stringify(compiledFlow.intentContract, null, 2),
      '',
      'Governed work loop:',
      JSON.stringify(compiledFlow.workLoop, null, 2),
    ].join('\n')
    : input.query;

  const parsedSlackPrompt =
    input.agentId === 'slack-surface-agent' && computedReceiver
      ? parseSlackSurfacePrompt(structuredQuery)
      : null;

  const routeContext: SurfaceRuntimeRouteContext = {
    input,
    compiledFlow,
    computedReceiver,
    structuredQuery,
    parsedSlackPrompt,
  };
  const matchedRouteHandler = SURFACE_RUNTIME_ROUTE_HANDLERS.find((handler) => handler.matches(routeContext));
  if (matchedRouteHandler) {
    return matchedRouteHandler.handle(routeContext);
  }

  const handle = await ensureSurfaceAgent(input.agentId, input.cwd);
  const firstResponse = await handle.ask(structuredQuery);
  const firstBlocks = extractSurfaceBlocks(firstResponse);
  let delegationResults: any[] = [];
  const delegationFallbackText = buildDelegationFallbackText(structuredQuery);

  if (firstBlocks.a2aMessages.length > 0) {
    delegationResults = await processDelegations(firstBlocks.a2aMessages, input.senderAgentId, delegationFallbackText);
  } else if (input.missionId && input.teamRole) {
    delegationResults = await routeMissionTeamDelegation(
      input.missionId,
      input.teamRole,
      structuredQuery,
      input.senderAgentId,
    );
  } else if (computedReceiver) {
    delegationResults = await routeForcedDelegation(
      computedReceiver,
      structuredQuery,
      input.senderAgentId,
      input.missionId,
    );
  }

  if (delegationResults.length === 0) {
    return firstBlocks;
  }

  const successful = delegationResults.filter((result) => !result.error);
  const routingProposals = successful.flatMap((result) => {
    const text = typeof result.response === 'string' ? result.response : '';
    return extractSurfaceBlocks(text).routingProposals || [];
  });
  const routedDelegationResults = routingProposals.length > 0
    ? await routeNerveRoutingProposals(routingProposals, input.senderAgentId, input.missionId)
    : [];
  const finalDelegationResults = [...delegationResults, ...routedDelegationResults];

  if (successful.length === 0 && routedDelegationResults.length === 0) {
    return {
      ...firstBlocks,
      delegationResults: finalDelegationResults,
      approvalRequests: firstBlocks.approvalRequests,
      routingProposals,
      missionProposals: firstBlocks.missionProposals,
      planningPackets: firstBlocks.planningPackets,
    };
  }

  const summaryContext = finalDelegationResults
    .filter((result) => !result.error)
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
    delegationResults: finalDelegationResults,
    approvalRequests: [...firstBlocks.approvalRequests, ...followUpBlocks.approvalRequests],
    routingProposals,
    missionProposals: [...(firstBlocks.missionProposals || []), ...(followUpBlocks.missionProposals || [])],
    planningPackets: [...(firstBlocks.planningPackets || []), ...(followUpBlocks.planningPackets || [])],
  };
}

export function deriveSlackExecutionMode(text: string): SlackExecutionMode {
  const normalized = text.trim();
  if (!normalized) return 'conversation';
  const rules = loadSlackSurfaceRules();
  if (matchesAnyTextRule(normalized, rules.execution_mode.feasibility_patterns)) {
    return 'conversation';
  }
  return matchesAnyTextRule(normalized, rules.execution_mode.durable_task_patterns)
    ? 'task'
    : 'conversation';
}

export function buildSlackSurfacePrompt(input: SlackSurfaceInput): string {
  const threadTs = input.threadTs || input.ts || 'unknown';
  const channelType = input.channelType || 'unknown';
  const normalizedText = input.text.trim();
  const language = /[ぁ-んァ-ン一-龯]/.test(normalizedText) ? 'ja' : 'en';
  const executionMode = deriveSlackExecutionMode(normalizedText);
  return [
    'You are handling a Slack conversation as the Slack Surface Agent.',
    `Channel: ${input.channel}`,
    `Thread: ${threadTs}`,
    `Channel type: ${channelType}`,
    `User: ${input.user || 'unknown'}`,
    `Derived intent: ${shouldForceSlackDelegation(normalizedText) ? 'request_deeper_reasoning' : 'request_lightweight_reply'}`,
    `Derived language: ${language}`,
    `Execution mode: ${executionMode}`,
    '',
    'User message:',
    normalizedText,
  ].join('\n');
}

export function shouldForceSlackDelegation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const rules = loadSlackSurfaceRules();
  return !matchesAnyTextRule(normalized, rules.delegation.lightweight_patterns);
}

export function recordSlackDelivery(
  correlationId: string,
  channel: string,
  threadTs: string,
  deliveryTs?: string,
  source: 'surface' | 'nerve' | 'system' = 'surface',
): string {
  return emitChannelSurfaceEvent('slack_bridge', 'slack', 'deliveries', {
    correlation_id: correlationId,
    decision: 'delivery_sent',
    why: 'Slack Surface Agent response was delivered back to the originating Slack thread.',
    policy_used: 'slack_surface_agent_v1',
    agent_id: 'slack-surface-agent',
    resource_id: deliveryTs || threadTs,
    slack_channel: channel,
    thread_ts: threadTs,
    response_source: source,
  });
}

function missionProposalStateLogicalPath(surface: 'slack' | 'chronos', channel: string, threadTs: string): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `active/shared/coordination/channels/${surface}/mission-proposals/${channel}-${safeThread}.json`;
}

function surfaceCoordinationRole(surface: 'slack' | 'chronos' | 'presence'): SurfaceRole {
  if (surface === 'chronos') return 'chronos_gateway';
  if (surface === 'presence') return 'surface_runtime';
  return 'slack_bridge';
}

function asyncRequestLogicalPath(surface: 'slack' | 'chronos' | 'presence', requestId: string): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/requests/${requestId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/requests/${requestId}.json`;
}

function surfaceNotificationLogicalPath(surface: 'slack' | 'chronos' | 'presence', notificationId: string): string {
  if (surface === 'presence') {
    return `active/shared/runtime/presence/notifications/${notificationId}.json`;
  }
  return `active/shared/coordination/channels/${surface}/notifications/${notificationId}.json`;
}

function surfaceOutboxLogicalPath(surface: 'slack' | 'chronos', messageId: string): string {
  return `active/shared/coordination/channels/${surface}/outbox/${messageId}.json`;
}

export function createSurfaceAsyncRequest(params: {
  surface: 'slack' | 'chronos' | 'presence';
  channel: string;
  threadTs: string;
  senderAgentId: string;
  surfaceAgentId: string;
  receiverAgentId: string;
  query: string;
  acceptedText: string;
  requestId?: string;
}): SurfaceAsyncRequestRecord {
  const request: SurfaceAsyncRequestRecord = {
    request_id: params.requestId || `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: params.surface,
    channel: params.channel,
    thread_ts: params.threadTs,
    sender_agent_id: params.senderAgentId,
    surface_agent_id: params.surfaceAgentId,
    receiver_agent_id: params.receiverAgentId,
    query: params.query,
    accepted_text: params.acceptedText,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return withSurfaceRole(surfaceCoordinationRole(params.surface), () => {
    writeJsonAs(surfaceCoordinationRole(params.surface), asyncRequestLogicalPath(params.surface, request.request_id), request);
    return request;
  });
}

export function getSurfaceAsyncRequest(surface: 'slack' | 'chronos' | 'presence', requestId: string): SurfaceAsyncRequestRecord | null {
  const resolved = pathResolver.resolve(asyncRequestLogicalPath(surface, requestId));
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as SurfaceAsyncRequestRecord;
}

export function updateSurfaceAsyncRequest(
  surface: 'slack' | 'chronos' | 'presence',
  requestId: string,
  patch: Partial<SurfaceAsyncRequestRecord>,
): SurfaceAsyncRequestRecord | null {
  const current = getSurfaceAsyncRequest(surface, requestId);
  if (!current) return null;
  const next: SurfaceAsyncRequestRecord = {
    ...current,
    ...patch,
    request_id: current.request_id,
    surface: current.surface,
    updated_at: new Date().toISOString(),
  };
  return withSurfaceRole(surfaceCoordinationRole(surface), () => {
    writeJsonAs(surfaceCoordinationRole(surface), asyncRequestLogicalPath(surface, requestId), next);
    return next;
  });
}

export function listSurfaceAsyncRequests(surface: 'slack' | 'chronos' | 'presence'): SurfaceAsyncRequestRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/requests'
      : `active/shared/coordination/channels/${surface}/requests`,
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceAsyncRequestRecord)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function enqueueSurfaceNotification(params: {
  surface: 'slack' | 'chronos' | 'presence';
  channel: string;
  threadTs: string;
  sourceAgentId: string;
  title: string;
  text: string;
  status?: 'info' | 'success' | 'error';
  requestId?: string;
}): SurfaceNotificationRecord {
  const notification: SurfaceNotificationRecord = {
    notification_id: `NTF-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    request_id: params.requestId,
    surface: params.surface,
    channel: params.channel,
    thread_ts: params.threadTs,
    source_agent_id: params.sourceAgentId,
    title: params.title,
    text: params.text,
    status: params.status || 'info',
    created_at: new Date().toISOString(),
  };
  return withSurfaceRole(surfaceCoordinationRole(params.surface), () => {
    writeJsonAs(surfaceCoordinationRole(params.surface), surfaceNotificationLogicalPath(params.surface, notification.notification_id), notification);
    return notification;
  });
}

export function listSurfaceNotifications(surface: 'slack' | 'chronos' | 'presence'): SurfaceNotificationRecord[] {
  const dir = pathResolver.resolve(
    surface === 'presence'
      ? 'active/shared/runtime/presence/notifications'
      : `active/shared/coordination/channels/${surface}/notifications`,
  );
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceNotificationRecord)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function enqueueSurfaceOutboxMessage(params: {
  surface: 'slack' | 'chronos';
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
}): string {
  const surfacePrefix = params.surface.toUpperCase();
  const record: SurfaceOutboxMessage = {
    message_id: `${surfacePrefix}-OUTBOX-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: params.surface,
    correlation_id: params.correlationId,
    channel: params.channel,
    thread_ts: params.threadTs,
    text: params.text,
    source: params.source || 'system',
    created_at: new Date().toISOString(),
  };
  return writeJsonAs('slack_bridge', surfaceOutboxLogicalPath(params.surface, record.message_id), record);
}

export function listSurfaceOutboxMessages(surface: 'slack' | 'chronos'): SurfaceOutboxMessage[] {
  const dir = pathResolver.resolve(`active/shared/coordination/channels/${surface}/outbox`);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(safeReadFile(path.join(dir, name), { encoding: 'utf8' }) as string) as SurfaceOutboxMessage);
}

export function clearSurfaceOutboxMessage(surface: 'slack' | 'chronos', messageId: string): void {
  const resolved = pathResolver.resolve(surfaceOutboxLogicalPath(surface, messageId));
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('slack_bridge', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function enqueueSlackOutboxMessage(params: {
  correlationId: string;
  channel: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'slack',
    ...params,
  });
}

export function enqueueChronosOutboxMessage(params: {
  correlationId: string;
  channel?: string;
  threadTs: string;
  text: string;
  source?: 'surface' | 'nerve' | 'system';
}): string {
  return enqueueSurfaceOutboxMessage({
    surface: 'chronos',
    correlationId: params.correlationId,
    channel: params.channel || 'chronos',
    threadTs: params.threadTs,
    text: params.text,
    source: params.source,
  });
}

export function listSlackOutboxMessages(): SlackOutboxMessage[] {
  return listSurfaceOutboxMessages('slack');
}

export function clearSlackOutboxMessage(messageId: string): void {
  clearSurfaceOutboxMessage('slack', messageId);
}

export function getSlackMissionProposalState(channel: string, threadTs: string): SlackMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('slack', channel, threadTs);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as SlackMissionProposalState;
}

export function saveSlackMissionProposalState(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
}): string {
  return writeJsonAs('slack_bridge', missionProposalStateLogicalPath('slack', params.channel, params.threadTs), {
    surface: 'slack',
    channel: params.channel,
    threadTs: params.threadTs,
    proposal: params.proposal,
    sourceText: params.sourceText,
    createdAt: new Date().toISOString(),
  } satisfies SlackMissionProposalState);
}

export function clearSlackMissionProposalState(channel: string, threadTs: string): void {
  const logicalPath = missionProposalStateLogicalPath('slack', channel, threadTs);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('slack_bridge', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function getChronosMissionProposalState(sessionId: string): ChronosMissionProposalState | null {
  const logicalPath = missionProposalStateLogicalPath('chronos', 'chronos', sessionId);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as ChronosMissionProposalState;
}

export function saveChronosMissionProposalState(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
}): string {
  return writeJsonAs('chronos_gateway', missionProposalStateLogicalPath('chronos', 'chronos', params.sessionId), {
    surface: 'chronos',
    channel: 'chronos',
    threadTs: params.sessionId,
    proposal: params.proposal,
    sourceText: params.sourceText,
    createdAt: new Date().toISOString(),
  } satisfies ChronosMissionProposalState);
}

export function clearChronosMissionProposalState(sessionId: string): void {
  const logicalPath = missionProposalStateLogicalPath('chronos', 'chronos', sessionId);
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) return;
  withSurfaceRole('chronos_gateway', () => {
    safeRmSync(resolved, { force: true });
  });
}

export function isSlackMissionConfirmation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return [
    /^はい[。！!]?$/,
    /^お願いします?[。！!]?$/,
    /^ではよろしく[。！!]?$/,
    /^よろしくお願いします?[。！!]?$/,
    /^進めて$/,
    /^go ahead$/,
    /^yes$/,
    /^approved?$/,
    /^please proceed$/,
  ].some((pattern) => pattern.test(normalized));
}

function sanitizeMissionSlug(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'REQUEST';
}

function buildSurfaceMissionId(prefix: string, threadTs: string, proposal: MissionProposal, sourceText?: string): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || 'request';
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, '').slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}

export async function issueSlackMissionFromProposal(params: {
  channel: string;
  threadTs: string;
  proposal: MissionProposal;
  sourceText?: string;
}): Promise<SlackMissionIssuanceResult> {
  const missionId = buildSurfaceMissionId('SLACK', params.threadTs, params.proposal, params.sourceText);
  const tier = params.proposal.tier || 'public';
  const missionType = params.proposal.mission_type || 'development';
  const persona = params.proposal.assigned_persona || 'Ecosystem Architect';
  const env = buildExecutionEnv(process.env, 'mission_controller');

  const startOutput = safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'start', missionId, tier, persona, 'default', missionType],
    { env, cwd: pathResolver.rootDir() },
  );
  let orchestrationStatus: SlackMissionIssuanceResult['orchestrationStatus'] = 'queued';
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    const orchestrationEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'slack_bridge',
      correlationId: randomUUID(),
      payload: {
        channel: params.channel,
        threadTs: params.threadTs,
        proposal: params.proposal,
        sourceText: params.sourceText,
        tier,
        persona,
        missionType,
      },
    });
    orchestrationJobPath = startMissionOrchestrationWorker(orchestrationEvent);
  } catch (error) {
    orchestrationStatus = 'failed';
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: randomUUID(),
    decision: 'mission_issued',
    why: 'A confirmed Slack mission proposal was deterministically issued through mission_controller.',
    policy_used: 'slack_mission_issue_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    thread_ts: params.threadTs,
    slack_channel: params.channel,
    mission_type: missionType,
    tier,
    orchestration_status: orchestrationStatus,
    orchestration_job_path: orchestrationJobPath,
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
  };
}

export async function issueChronosMissionFromProposal(params: {
  sessionId: string;
  proposal: MissionProposal;
  sourceText?: string;
}): Promise<SlackMissionIssuanceResult> {
  const missionId = buildSurfaceMissionId('CHRONOS', params.sessionId, params.proposal, params.sourceText);
  const tier = params.proposal.tier || 'public';
  const missionType = params.proposal.mission_type || 'development';
  const persona = params.proposal.assigned_persona || 'Ecosystem Architect';
  const env = buildExecutionEnv(process.env, 'mission_controller');

  const startOutput = safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'start', missionId, tier, persona, 'default', missionType],
    { env, cwd: pathResolver.rootDir() },
  );

  let orchestrationStatus: SlackMissionIssuanceResult['orchestrationStatus'] = 'queued';
  let orchestrationJobPath: string | undefined;
  let orchestrationError: string | undefined;
  try {
    const orchestrationEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_issue_requested',
      missionId,
      requestedBy: 'chronos_gateway',
      correlationId: randomUUID(),
      payload: {
        sessionId: params.sessionId,
        proposal: params.proposal,
        sourceText: params.sourceText,
        tier,
        persona,
        missionType,
        channel: 'chronos',
        threadTs: params.sessionId,
      },
    });
    orchestrationJobPath = startMissionOrchestrationWorker(orchestrationEvent);
  } catch (error) {
    orchestrationStatus = 'failed';
    orchestrationError = error instanceof Error ? error.message : String(error);
  }

  emitChronosEvent('missions', {
    correlation_id: randomUUID(),
    decision: 'mission_issued',
    why: 'A confirmed Chronos mission proposal was deterministically issued through mission_controller.',
    policy_used: 'chronos_mission_issue_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    mission_type: missionType,
    tier,
    session_id: params.sessionId,
    orchestration_status: orchestrationStatus,
    orchestration_job_path: orchestrationJobPath,
  });

  return {
    missionId,
    tier,
    missionType,
    persona,
    startOutput,
    orchestrationStatus,
    orchestrationJobPath,
    orchestrationError,
  };
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
