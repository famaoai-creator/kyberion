import { randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { a2aBridge } from './a2a-bridge.js';
import type { A2AMessage } from './a2a-bridge.js';
import { getAgentManifest } from './agent-manifest.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from './agent-runtime-supervisor.js';
import {
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import { compileUserIntentFlow, formatClarificationPacket } from './intent-contract.js';
import { logger } from './core.js';
import { buildMissionTeamView, loadMissionTeamPlan, resolveMissionTeamReceiver } from './mission-team-composer.js';
import { buildSurfaceConversationInput } from './surface-interaction-model.js';
import {
  deriveSlackExecutionModeFromProviderPolicy,
  deriveSlackIntentLabelFromProviderPolicy,
  shouldForceSlackDelegationFromProviderPolicy,
} from './surface-provider-policy.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import {
  buildDelegationFallbackText,
  deriveSurfaceDelegationReceiver,
  normalizeSurfaceDelegationReceiver,
  parseSlackSurfacePrompt,
  resolveSurfaceConversationReceiver,
  shouldCompileSurfaceIntent,
  surfaceChannelFromAgentId,
  surfaceRoutingText,
  type SurfaceDelegationReceiver,
  type SurfaceRuntimeRouteContext,
} from './surface-runtime-router.js';

import type {
  NerveRoutingProposal,
  ParsedSlackSurfacePrompt,
  SurfaceDelegationResult,
  SlackExecutionMode,
  SlackSurfaceInput,
  SurfaceConversationInput,
  SurfaceConversationMessageInput,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';

interface SurfaceRuntimeRouteHandler {
  matches: (context: SurfaceRuntimeRouteContext) => boolean;
  handle: (context: SurfaceRuntimeRouteContext) => Promise<SurfaceConversationResult>;
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

export function deriveSlackIntentLabel(text: string): string {
  return deriveSlackIntentLabelFromProviderPolicy(text);
}

export function deriveSlackExecutionMode(text: string): SlackExecutionMode {
  return deriveSlackExecutionModeFromProviderPolicy(text);
}

export function shouldForceSlackDelegation(text: string): boolean {
  return shouldForceSlackDelegationFromProviderPolicy(text);
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

async function processDelegations(a2aMessages: A2AMessage[], senderAgentId: string, fallbackText: string): Promise<SurfaceDelegationResult[]> {
  const delegationResults: SurfaceDelegationResult[] = [];

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
): Promise<SurfaceDelegationResult[]> {
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
  parsedSlackPrompt?: ParsedSlackSurfacePrompt | null,
  missionId?: string,
): Promise<SurfaceDelegationResult[]> {
  const parsed = parsedSlackPrompt || parseSlackSurfacePrompt(query);
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
): Promise<SurfaceDelegationResult[]> {
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
): Promise<SurfaceDelegationResult[]> {
  if (!missionId) return [];
  const results: SurfaceDelegationResult[] = [];
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
    context.parsedSlackPrompt,
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
  const routedSurfaceInput = surfaceRoutingText(input);
  const surface = input.surface || surfaceChannelFromAgentId(input.agentId);
  const ruleBasedReceiver = forcedReceiver || deriveSurfaceDelegationReceiver(routedSurfaceInput.text, surface);
  const compiledFlow: UserIntentFlow | null = shouldCompileSurfaceIntent(input, routedSurfaceInput.text, ruleBasedReceiver)
    ? await compileUserIntentFlow({
      text: routedSurfaceInput.text,
      channel: input.agentId.includes('slack') ? 'slack' : input.agentId.includes('presence') ? 'presence' : 'surface',
    }).catch((error: any) => {
      logger.warn(`[SURFACE] Intent contract compilation failed: ${error?.message || String(error)}`);
      return null;
    })
    : null;

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

  const computedReceiver: SurfaceDelegationReceiver | undefined = forcedReceiver ||
    ruleBasedReceiver ||
    (!forcedReceiver && compiledFlow
      ? resolveSurfaceConversationReceiver(undefined, compiledFlow, surface)
      : undefined);

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
      ? routedSurfaceInput.parsedSlackPrompt || (!input.surfaceText ? parseSlackSurfacePrompt(structuredQuery) : null)
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
  let delegationResults: SurfaceDelegationResult[] = [];
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

export async function runSurfaceMessageConversation(input: SurfaceConversationMessageInput): Promise<SurfaceConversationResult> {
  return runSurfaceConversation(buildSurfaceConversationInput(input));
}
