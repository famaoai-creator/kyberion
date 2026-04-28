import { randomUUID } from 'node:crypto';

import { pathResolver } from './path-resolver.js';
import { safeExec } from './secure-io.js';
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
import { resolveSurfaceIntent } from './router-contract.js';
import { recordIntentContractOutcome, selectContractCandidates, type ContractCandidate } from './intent-contract-learning.js';

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

function emptySurfaceResult(text: string): SurfaceConversationResult {
  return {
    text,
    a2uiMessages: [],
    a2aMessages: [],
    delegationResults: [],
    approvalRequests: [],
    routingProposals: [],
    missionProposals: [],
    planningPackets: [],
  };
}

function formatExecutionReceipt(params: {
  intentId?: string;
  shape?: string;
  command?: string;
  status: 'ok' | 'error';
  candidateSelection?: ContractCandidate[];
}): string {
  return JSON.stringify({
    kind: 'execution-receipt',
    ts: new Date().toISOString(),
    intent_id: params.intentId || 'unknown',
    execution_shape: params.shape || 'unknown',
    command: params.command || '',
    status: params.status,
    candidate_selection: (params.candidateSelection || []).map((candidate) => ({
      contract_ref: candidate.contract_ref,
      score: candidate.score,
      source: candidate.source,
    })),
  }, null, 2);
}

function ensureMissionId(context: SurfaceRuntimeRouteContext): string {
  if (context.input.missionId) return context.input.missionId;
  throw new Error('mission_id is required for this mission action');
}

function recordLearningOutcomeSafely(params: Parameters<typeof recordIntentContractOutcome>[0]): void {
  try {
    recordIntentContractOutcome(params);
  } catch {
    // Learning updates are best-effort and must not block primary execution paths.
  }
}

function missionActionGuidance(action: NonNullable<ReturnType<typeof resolveSurfaceIntent>['missionAction']>, missionId: string): string {
  const commandHints: Record<string, string> = {
    classify: `node dist/scripts/mission_controller.js status ${missionId}`,
    workflow: `node dist/scripts/compose_mission_team.js --mission-id ${missionId} --execution-shape mission --request "select workflow"`,
    review_output: `node dist/scripts/mission_controller.js verify ${missionId} verified "worker output reviewed"`,
    handoff: `node dist/scripts/mission_controller.js checkpoint ${missionId} handoff "handoff requested"`,
  };
  const hint = commandHints[action];
  return hint
    ? `Mission action '${action}' has no dedicated direct binding yet. Recommended command:\n${hint}`
    : `Mission action '${action}' has no direct binding yet.`;
}

function directIntentCommand(intentId?: string): { command: string; args: string[] } | null {
  const map: Record<string, { command: string; args: string[] }> = {
    'bootstrap-kyberion-runtime': { command: 'pnpm', args: ['env:bootstrap'] },
    'verify-actuator-capability': { command: 'pnpm', args: ['capabilities'] },
  };
  return intentId && map[intentId] ? map[intentId] : null;
}

async function handleGovernedExecutionHint(context: SurfaceRuntimeRouteContext): Promise<SurfaceConversationResult> {
  const resolved = resolveSurfaceIntent(context.input.surfaceText || context.structuredQuery);
  const intentId = resolved.intentId;
  const candidates = intentId ? selectContractCandidates(intentId, 3) : [];
  const direct = directIntentCommand(resolved.intentId);
  if (direct) {
    const command = `${direct.command} ${direct.args.join(' ')}`;
    try {
      const output = safeExec(direct.command, direct.args, { cwd: pathResolver.rootDir() });
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: command },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      return emptySurfaceResult(
        [
          `Executed intent command: ${resolved.intentId}`,
          '',
          formatExecutionReceipt({
            intentId: resolved.intentId,
            shape: resolved.shape,
            command,
            status: 'ok',
            candidateSelection: candidates,
          }),
          '',
          output.trim() || '(no output)',
        ].join('\n'),
      );
    } catch (error: any) {
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: command },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
  }

  if (resolved.pipelineId) {
    const pipelinePath = `pipelines/${resolved.pipelineId}.json`;
    const command = `node dist/scripts/run_pipeline.js --input ${pipelinePath}`;
    let output = '';
    try {
      output = safeExec('node', ['dist/scripts/run_pipeline.js', '--input', pipelinePath], {
        cwd: pathResolver.rootDir(),
      });
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'pipeline',
          contract_ref: { kind: 'pipeline', ref: resolved.pipelineId },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
    } catch (error: any) {
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'pipeline',
          contract_ref: { kind: 'pipeline', ref: resolved.pipelineId },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
    return emptySurfaceResult(
      [
        `Executed pipeline: ${resolved.pipelineId}`,
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: resolved.shape,
          command,
          status: 'ok',
          candidateSelection: candidates,
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n'),
    );
  }

  if (!resolved.missionAction) {
    throw new Error('governed execution hint not found');
  }

  if (resolved.missionAction === 'create') {
    const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const command = `node dist/scripts/mission_controller.js create ${missionId} public`;
    let output = '';
    try {
      output = safeExec('node', ['dist/scripts/mission_controller.js', 'create', missionId, 'public'], {
        cwd: pathResolver.rootDir(),
      });
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: true,
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
    } catch (error: any) {
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: resolved.shape || 'mission',
          contract_ref: { kind: 'mission_command', ref: 'mission_controller create' },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: resolved.shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      throw error;
    }
    return emptySurfaceResult(
      [
        `Created mission: ${missionId}`,
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: resolved.shape,
          command,
          status: 'ok',
          candidateSelection: candidates,
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n'),
    );
  }

  const missionId = ensureMissionId(context);
  const missionCommandByAction: Record<string, string[] | undefined> = {
    classify: ['classify', missionId],
    workflow: ['workflow-select', missionId],
    inspect_state: ['status', missionId],
    compose_team: ['team', missionId],
    prewarm_team: ['prewarm', missionId],
    delegate_task: ['delegate', missionId, 'generalist', context.input.surfaceText || context.structuredQuery],
    review_output: ['review-worker-output', missionId, 'verified', 'worker output reviewed from surface intent'],
    handoff: ['handoff', missionId, 'surface_operator', 'handoff requested from surface intent'],
    distill: ['distill', missionId],
    close: ['finish', missionId],
  };
  const mapped = missionCommandByAction[resolved.missionAction];
  if (!mapped) {
    return emptySurfaceResult(missionActionGuidance(resolved.missionAction, missionId));
  }
  const command = `node dist/scripts/mission_controller.js ${mapped.join(' ')}`;
  let output = '';
  try {
    output = safeExec('node', ['dist/scripts/mission_controller.js', ...mapped], {
      cwd: pathResolver.rootDir(),
    });
    if (intentId) {
      recordLearningOutcomeSafely({
        intent_id: intentId,
        execution_shape: resolved.shape || 'mission',
        contract_ref: { kind: 'mission_command', ref: `mission_controller ${resolved.missionAction}` },
        success: true,
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
  } catch (error: any) {
    if (intentId) {
      recordLearningOutcomeSafely({
        intent_id: intentId,
        execution_shape: resolved.shape || 'mission',
        contract_ref: { kind: 'mission_command', ref: `mission_controller ${resolved.missionAction}` },
        success: false,
        error: error?.message || String(error),
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
    throw error;
  }
  return emptySurfaceResult(
    [
      `Executed mission action: ${resolved.missionAction} (${missionId})`,
      '',
      formatExecutionReceipt({
        intentId: resolved.intentId,
        shape: resolved.shape,
        command,
        status: 'ok',
        candidateSelection: candidates,
      }),
      '',
      output.trim() || '(no output)',
    ].join('\n'),
  );
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
    matches: (context) => {
      if (!context.compiledFlow) return false;
      const resolved = resolveSurfaceIntent(context.input.surfaceText || context.structuredQuery);
      return Boolean(resolved.pipelineId || resolved.missionAction);
    },
    handle: async (context) => {
      try {
        return await handleGovernedExecutionHint(context);
      } catch (error: any) {
        return emptySurfaceResult(`Governed execution failed: ${error?.message || String(error)}`);
      }
    },
  },
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
