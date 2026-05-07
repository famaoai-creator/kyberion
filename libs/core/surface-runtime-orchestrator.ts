import { randomUUID } from 'node:crypto';
import { buildKnowledgeIndex, queryKnowledge, type KnowledgeHintIndex } from './src/knowledge-index.js';

import { pathResolver } from './path-resolver.js';
import { secureFetch } from './network.js';
import { safeExec } from './secure-io.js';
import { a2aBridge } from './a2a-bridge.js';
import type { A2AMessage } from './a2a-bridge.js';
import { getAgentManifest, resolveAgentSelectionHints } from './agent-manifest.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from './agent-runtime-supervisor.js';
import {
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import { compileUserIntentFlow, formatClarificationPacket } from './intent-contract.js';
import { logger } from './core.js';
import {
  buildMissionTeamView,
  loadMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { buildSurfaceConversationInput } from './surface-interaction-model.js';
import { classifyTaskSessionIntent, createTaskSession, saveTaskSession } from './task-session.js';
import { executeApprovedClaudeTaskSession } from './claude-task-session-executor.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
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
import {
  recordIntentContractOutcome,
  selectContractCandidates,
  type ContractCandidate,
} from './intent-contract-learning.js';

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

function buildDelegatedSurfaceConversationResult(
  delegationResults: SurfaceDelegationResult[]
): SurfaceConversationResult {
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

function attachRoutingDecision(
  result: SurfaceConversationResult,
  routingDecision?: UserIntentFlow['routingDecision'],
): SurfaceConversationResult {
  return routingDecision ? { ...result, routingDecision } : result;
}

function formatExecutionReceipt(params: {
  intentId?: string;
  shape?: string;
  command?: string;
  status: 'ok' | 'error';
  candidateSelection?: ContractCandidate[];
}): string {
  return JSON.stringify(
    {
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
    },
    null,
    2
  );
}

function structuredSurfaceQueryText(context: SurfaceRuntimeRouteContext): string {
  return (context.input.surfaceText || context.input.query || context.structuredQuery || '').trim();
}

function resolvedSurfaceIntent(context: SurfaceRuntimeRouteContext): ReturnType<typeof resolveSurfaceIntent> {
  return context.resolvedIntent || resolveSurfaceIntent(structuredSurfaceQueryText(context));
}

function deriveSurfaceQueryRole(context: SurfaceRuntimeRouteContext): string | undefined {
  if (context.input.agentId.includes('presence')) return 'presence_surface_agent';
  if (context.input.agentId.includes('slack')) return 'slack_surface_agent';
  if (context.input.agentId.includes('chronos')) return 'chronos_surface_agent';
  return undefined;
}

let knowledgeIndexPromise: Promise<KnowledgeHintIndex> | null = null;

async function loadKnowledgeHintIndex(): Promise<KnowledgeHintIndex> {
  knowledgeIndexPromise ||= buildKnowledgeIndex(pathResolver.knowledge());
  return knowledgeIndexPromise;
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractDuckDuckGoResults(html: string, limit = 3): Array<{ title: string; url: string; snippet?: string }> {
  const anchors = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const results: Array<{ title: string; url: string; snippet?: string }> = [];

  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const anchor = anchors[i];
    const nextAnchorIndex = anchors[i + 1]?.index ?? html.length;
    const block = html.slice(anchor.index || 0, nextAnchorIndex);
    const snippetMatch = block.match(/result__snippet[^>]*>([\s\S]*?)<\/a>/);
    const rawUrl = anchor[1];
    const url = (() => {
      try {
        const parsed = new URL(rawUrl, 'https://duckduckgo.com');
        const forwarded = parsed.searchParams.get('uddg');
        return forwarded ? decodeURIComponent(forwarded) : parsed.toString();
      } catch {
        return rawUrl;
      }
    })();
    results.push({
      title: decodeHtmlEntities(stripHtmlTags(anchor[2]).trim()),
      url,
      snippet: snippetMatch ? decodeHtmlEntities(stripHtmlTags(snippetMatch[1]).trim()) : undefined,
    });
  }

  return results;
}

function extractLocationHint(queryText: string): string | null {
  const stripped = queryText
    .replace(/(今日|今|現在|明日|この|その|あの)?(の)?(天気|weather|forecast|気温|降水確率|雨|晴れ|天候)/gi, ' ')
    .replace(/(を)?(教えて|知りたい|見せて|検索して|調べて|お願いします|please)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  if (/^(です|ます|ください|please|weather|forecast)$/i.test(stripped)) return null;
  return stripped;
}

async function fetchCurrentLocationSummary(): Promise<string> {
  const data = await secureFetch<any>({
    method: 'GET',
    url: 'https://ipapi.co/json/',
  });
  const parts = [
    data?.city,
    data?.region || data?.region_code,
    data?.country_name || data?.country,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'unknown location';
}

async function fetchWeatherSummary(queryText: string): Promise<string> {
  const locationHint = extractLocationHint(queryText);
  let latitude: number | undefined;
  let longitude: number | undefined;
  let label = locationHint || '';

  if (locationHint) {
    const geocode = await secureFetch<any>({
      method: 'GET',
      url: 'https://geocoding-api.open-meteo.com/v1/search',
      params: {
        name: locationHint,
        count: 1,
        language: 'ja',
        format: 'json',
      },
    });
    const candidate = geocode?.results?.[0];
    latitude = candidate?.latitude;
    longitude = candidate?.longitude;
    label = candidate?.name || locationHint;
  }

  if (latitude === undefined || longitude === undefined) {
    const currentLocation = await secureFetch<any>({
      method: 'GET',
      url: 'https://ipapi.co/json/',
    });
    latitude = currentLocation?.latitude;
    longitude = currentLocation?.longitude;
    label = currentLocation?.city
      ? [currentLocation.city, currentLocation.region, currentLocation.country_name]
          .filter(Boolean)
          .join(', ')
      : 'current location';
  }

  if (latitude === undefined || longitude === undefined) {
    throw new Error('weather location could not be resolved');
  }

  const weather = await secureFetch<any>({
    method: 'GET',
    url: 'https://api.open-meteo.com/v1/forecast',
    params: {
      latitude,
      longitude,
      current: 'temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m',
      timezone: 'auto',
    },
  });
  const current = weather?.current || {};
  const temperature = current.temperature_2m;
  const weatherCode = current.weather_code;
  const wind = current.wind_speed_10m;
  const humidity = current.relative_humidity_2m;

  return [
    `Weather for ${label}:`,
    typeof temperature === 'number' ? `temperature ${temperature}°C` : 'temperature unavailable',
    weatherCode !== undefined ? `code ${weatherCode}` : 'weather code unavailable',
    typeof wind === 'number' ? `wind ${wind} km/h` : 'wind unavailable',
    typeof humidity === 'number' ? `humidity ${humidity}%` : 'humidity unavailable',
  ].join(', ');
}

async function runWebSearch(queryText: string): Promise<string> {
  const response = await secureFetch<string>({
    method: 'GET',
    url: 'https://html.duckduckgo.com/html/',
    params: {
      q: queryText,
    },
  });
  const results = extractDuckDuckGoResults(response, 3);
  if (results.length === 0) {
    return `No web search results were parsed for: ${queryText}`;
  }
  return [
    `Web search results for: ${queryText}`,
    ...results.map((result, index) => {
      const snippet = result.snippet ? `\n  ${result.snippet}` : '';
      return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
    }),
  ].join('\n');
}

async function handleSurfaceQueryRoute(
  context: SurfaceRuntimeRouteContext,
  resolved: ReturnType<typeof resolveSurfaceIntent>
): Promise<SurfaceConversationResult> {
  const queryText = resolved.queryText || structuredSurfaceQueryText(context);
  const queryType = resolved.queryType || 'knowledge_search';
  const providerConfig = getSurfaceQueryProviderConfig({
    role: deriveSurfaceQueryRole(context),
    phase: process.env.KYBERION_SURFACE_QUERY_PHASE?.trim() || undefined,
  });

  if (!queryText) {
    return emptySurfaceResult('No query text was provided.');
  }

  if (queryType === 'knowledge_search') {
    const providerLabel = providerConfig.knowledge?.provider || 'local_index';
    const index = await loadKnowledgeHintIndex();
    const results = queryKnowledge(index, queryText, { maxResults: 5 });
    const text =
      results.length === 0
        ? `No local knowledge hints matched: ${queryText}`
        : [
            `Knowledge results for: ${queryText}`,
            `Provider: ${providerLabel}`,
            ...results.map((result, index) => {
              const source = result.source ? ` (${result.source})` : '';
              const tags = result.tags?.length ? ` [${result.tags.join(', ')}]` : '';
              return `${index + 1}. ${result.topic}${source}${tags}\n   ${result.hint}`;
            }),
          ].join('\n');
    if (resolved.intentId) {
      recordLearningOutcomeSafely({
        intent_id: resolved.intentId,
        execution_shape: resolved.shape || 'direct_reply',
        contract_ref: { kind: 'direct_reply', ref: 'knowledge-query' },
        success: true,
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
    return emptySurfaceResult(
      [
        text,
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: resolved.shape,
          command: `knowledge-query ${queryText}`,
          status: 'ok',
        }),
      ].join('\n')
    );
  }

  let answer = '';
  if (queryType === 'location') {
    if (providerConfig.location?.enabled === false) {
      return emptySurfaceResult('Location provider is disabled by configuration.');
    }
    const providerLabel = providerConfig.location?.provider || 'presence_context';
    answer = `Provider: ${providerLabel}\nCurrent location: ${await fetchCurrentLocationSummary()}`;
  } else if (queryType === 'weather') {
    if (providerConfig.weather?.enabled === false) {
      return emptySurfaceResult('Weather provider is disabled by configuration.');
    }
    const providerLabel = providerConfig.weather?.provider || 'open_meteo';
    answer = `Provider: ${providerLabel}\n${await fetchWeatherSummary(queryText)}`;
  } else if (queryType === 'web_search') {
    if (providerConfig.web_search?.enabled === false) {
      return emptySurfaceResult('Web search provider is disabled by configuration.');
    }
    const providerLabel = providerConfig.web_search?.provider || 'duckduckgo_html';
    answer = `Provider: ${providerLabel}\n${await runWebSearch(queryText)}`;
  } else {
    answer = `Unsupported live query type for: ${queryText}`;
  }

  if (resolved.intentId) {
    recordLearningOutcomeSafely({
      intent_id: resolved.intentId,
      execution_shape: resolved.shape || 'direct_reply',
      contract_ref: { kind: 'direct_reply', ref: `live-query:${queryType}` },
      success: true,
      context_fingerprint: {
        execution_shape: resolved.shape,
        surface: context.input.surface || 'unknown',
      },
    });
  }

  return emptySurfaceResult(
    [
      answer,
      '',
      formatExecutionReceipt({
        intentId: resolved.intentId,
        shape: resolved.shape,
        command: `live-query ${queryType} ${queryText}`,
        status: 'ok',
      }),
    ].join('\n')
  );
}

async function handleTaskSessionRoute(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const queryText = structuredSurfaceQueryText(context);
  const intent = classifyTaskSessionIntent(queryText);
  if (!intent?.intentId) {
    return emptySurfaceResult('No task-session intent could be resolved.');
  }

  const session = createTaskSession({
    sessionId: `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    surface: context.input.surface || 'presence',
    taskType: intent.taskType,
    status: intent.requirements?.missing?.length ? 'collecting_requirements' : 'planning',
    intentId: intent.intentId,
    goal: intent.goal,
    projectContext: intent.projectContext,
    requirements: intent.requirements,
    payload: intent.payload,
  });
  saveTaskSession(session);

  const shouldExecuteClaudeTask =
    session.requirements?.missing?.length === 0 &&
    (session.task_type === 'browser' ||
      session.task_type === 'report_document' ||
      session.task_type === 'document_generation');

  if (shouldExecuteClaudeTask) {
    try {
      const result = await executeApprovedClaudeTaskSession({
        session,
        queryText,
        agentId: context.input.agentId,
        channel: context.input.surface,
        missionId: context.input.missionId,
      });
      if (intent.intentId) {
        recordLearningOutcomeSafely({
          intent_id: intent.intentId,
          execution_shape: result.session.work_loop?.resolution.execution_shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
          success: true,
          context_fingerprint: {
            execution_shape: result.session.work_loop?.resolution.execution_shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      return emptySurfaceResult(
        [
          `Created task session: ${result.session.session_id}`,
          `Intent: ${intent.intentId}`,
          `Task type: ${result.session.task_type}`,
          `Goal: ${result.session.goal.summary}`,
          `Claude runner kind: ${result.kind}`,
          `Artifact: ${result.outputPath}`,
          '',
          formatExecutionReceipt({
            intentId: intent.intentId,
            shape: result.session.work_loop?.resolution.execution_shape || 'task_session',
            command: `claude-task-session ${result.kind} ${result.session.session_id}`,
            status: 'ok',
          }),
          '',
          result.output.trim() || '(no output)',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error: any) {
      logger.warn(
        `[SURFACE] Claude task-session execution failed for ${session.session_id}: ${error?.message || String(error)}`,
      );
      if (intent.intentId) {
        recordLearningOutcomeSafely({
          intent_id: intent.intentId,
          execution_shape: session.work_loop?.resolution.execution_shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: session.work_loop?.resolution.execution_shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      return emptySurfaceResult(
        [
          `Created task session: ${session.session_id}`,
          `Intent: ${intent.intentId}`,
          `Task type: ${session.task_type}`,
          `Goal: ${session.goal.summary}`,
          `Claude runner execution failed: ${error?.message || String(error)}`,
        ].join('\n'),
      );
    }
  }

  if (intent.intentId) {
    recordLearningOutcomeSafely({
      intent_id: intent.intentId,
      execution_shape: session.work_loop?.resolution.execution_shape || 'task_session',
      contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
      success: true,
      context_fingerprint: {
        execution_shape: session.work_loop?.resolution.execution_shape,
        surface: context.input.surface || 'unknown',
      },
    });
  }

  const missing = session.requirements?.missing?.length
    ? `Missing inputs: ${session.requirements.missing.join(', ')}`
    : 'No missing inputs were detected.';

  const handoffIntentId =
    typeof session.payload?.['handoff_intent_id'] === 'string'
      ? String(session.payload['handoff_intent_id'])
      : '';
  const handoff = handoffIntentId ? `Handoff intent: ${handoffIntentId}` : '';

  return emptySurfaceResult(
    [
      `Created task session: ${session.session_id}`,
      `Intent: ${intent.intentId}`,
      `Task type: ${session.task_type}`,
      `Goal: ${session.goal.summary}`,
      missing,
      handoff,
      '',
      formatExecutionReceipt({
        intentId: intent.intentId,
        shape: session.work_loop?.resolution.execution_shape || 'task_session',
        command: `task-session ${intent.intentId}`,
        status: 'ok',
      }),
    ]
      .filter(Boolean)
      .join('\n')
  );
}

function ensureMissionId(context: SurfaceRuntimeRouteContext): string {
  if (context.input.missionId) return context.input.missionId;
  throw new Error('mission_id is required for this mission action');
}

function recordLearningOutcomeSafely(
  params: Parameters<typeof recordIntentContractOutcome>[0]
): void {
  try {
    recordIntentContractOutcome(params);
  } catch {
    // Learning updates are best-effort and must not block primary execution paths.
  }
}

function missionActionGuidance(
  action: NonNullable<ReturnType<typeof resolveSurfaceIntent>['missionAction']>,
  missionId: string
): string {
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

function buildSurfaceDelegationRequest(params: {
  senderAgentId: string;
  receiver: string;
  query: string;
  intent: string;
  context?: Record<string, unknown>;
}): Parameters<typeof a2aBridge.route>[0] {
  const payload: Record<string, unknown> = {
    intent: params.intent,
    text: params.query,
  };
  if (params.context && Object.keys(params.context).length > 0) {
    payload.context = params.context;
  }
  return {
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6)}`,
      sender: params.senderAgentId,
      receiver: params.receiver,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload,
  };
}

function directIntentCommand(intentId?: string): { command: string; args: string[] } | null {
  const map: Record<string, { command: string; args: string[] }> = {
    'bootstrap-kyberion-runtime': { command: 'pnpm', args: ['env:bootstrap'] },
    'verify-actuator-capability': { command: 'pnpm', args: ['capabilities'] },
  };
  return intentId && map[intentId] ? map[intentId] : null;
}

async function handleGovernedExecutionHint(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const resolved = resolveSurfaceIntent(context.input.surfaceText || context.structuredQuery);
  const intentId = resolved.intentId;
  const candidates = intentId ? selectContractCandidates(intentId, 3) : [];
  const routingDecisionArgs = context.compiledFlow?.routingDecision
    ? ['--routing-decision', JSON.stringify(context.compiledFlow.routingDecision)]
    : [];
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
        ].join('\n')
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
      ].join('\n')
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
      output = safeExec(
        'node',
        ['dist/scripts/mission_controller.js', 'create', missionId, 'public', ...routingDecisionArgs],
        {
          cwd: pathResolver.rootDir(),
        }
      );
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
      ].join('\n')
    );
  }

  const missionId = ensureMissionId(context);
  const missionCommandByAction: Record<string, string[] | undefined> = {
    classify: ['classify', missionId],
    workflow: ['workflow-select', missionId],
    inspect_state: ['status', missionId],
    compose_team: ['team', missionId],
    prewarm_team: ['prewarm', missionId],
    delegate_task: [
      'delegate',
      missionId,
      'generalist',
      context.input.surfaceText || context.structuredQuery,
    ],
    review_output: [
      'review-worker-output',
      missionId,
      'verified',
      'worker output reviewed from surface intent',
    ],
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
    output = safeExec('node', ['dist/scripts/mission_controller.js', ...mapped, ...routingDecisionArgs], {
      cwd: pathResolver.rootDir(),
    });
    if (intentId) {
      recordLearningOutcomeSafely({
        intent_id: intentId,
        execution_shape: resolved.shape || 'mission',
        contract_ref: {
          kind: 'mission_command',
          ref: `mission_controller ${resolved.missionAction}`,
        },
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
        contract_ref: {
          kind: 'mission_command',
          ref: `mission_controller ${resolved.missionAction}`,
        },
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
    ].join('\n')
  );
}

function buildMissionTeamPromptContext(missionId: string): string {
  const plan = loadMissionTeamPlan(missionId);
  if (!plan) return '';
  const teamView = buildMissionTeamView(plan);
  return [
    '',
    'Mission team context:',
    JSON.stringify(
      {
        mission_id: plan.mission_id,
        mission_type: plan.mission_type,
        team: teamView,
      },
      null,
      2
    ),
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
  const { provider, modelId } = resolveAgentSelectionHints(manifest);

  const spawnOptions = {
    agentId,
    provider,
    modelId,
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
    const snapshot = await ensureAgentRuntimeViaDaemon(toSupervisorEnsurePayload(spawnOptions));
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

async function processDelegations(
  a2aMessages: A2AMessage[],
  senderAgentId: string,
  fallbackText: string
): Promise<SurfaceDelegationResult[]> {
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
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  try {
    const enrichedQuery =
      receiver === 'nerve-agent' && missionId
        ? `${query}\n${buildMissionTeamPromptContext(missionId)}`
        : query;
    const response = await a2aBridge.route(
      buildSurfaceDelegationRequest({
        senderAgentId,
        receiver,
        query: enrichedQuery,
        intent: 'surface_handoff',
      })
    );

    return [
      {
        receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
      },
    ];
  } catch (err: any) {
    return [
      {
        receiver,
        error: err.message,
      },
    ];
  }
}

async function routeSlackForcedDelegation(
  receiver: string,
  query: string,
  senderAgentId: string,
  parsedSlackPrompt?: ParsedSlackSurfacePrompt | null,
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  const parsed = parsedSlackPrompt || parseSlackSurfacePrompt(query);
  if (!parsed) {
    return routeForcedDelegation(receiver, query, senderAgentId, missionId);
  }

  try {
    const response = await a2aBridge.route(
      buildSurfaceDelegationRequest({
        senderAgentId,
        receiver,
        query: parsed.userMessage,
        intent: deriveSlackIntentLabel(parsed.userMessage),
        context: {
          channel: 'slack',
          slack_channel: parsed.channel,
          thread: parsed.thread,
          user: parsed.user,
          user_language: parsed.derivedLanguage,
          execution_mode: parsed.executionMode || 'conversation',
        },
      })
    );

    return [
      {
        receiver,
        response: response.payload?.text || JSON.stringify(response.payload),
        bypassedSurfaceAgent: true,
      },
    ];
  } catch (err: any) {
    return [
      {
        receiver,
        error: err.message,
        bypassedSurfaceAgent: true,
      },
    ];
  }
}

async function routeMissionTeamDelegation(
  missionId: string,
  teamRole: string,
  query: string,
  senderAgentId: string
): Promise<SurfaceDelegationResult[]> {
  const assignment = resolveMissionTeamReceiver({ missionId, teamRole });
  if (!assignment?.agent_id) {
    return [
      {
        receiver: `${missionId}:${teamRole}`,
        error: `No assigned agent for team role ${teamRole} in mission ${missionId}`,
      },
    ];
  }

  const results = await routeForcedDelegation(assignment.agent_id, query, senderAgentId, missionId);
  return results.map((result) => ({
    ...result,
    missionId,
    teamRole,
    authorityRole: assignment.authority_role || undefined,
  }));
}

async function routeNerveRoutingProposals(
  proposals: NerveRoutingProposal[],
  senderAgentId: string,
  missionId?: string
): Promise<SurfaceDelegationResult[]> {
  if (!missionId) return [];
  const results: SurfaceDelegationResult[] = [];
  for (const proposal of proposals) {
    if (proposal.intent !== 'delegate_task' || !proposal.team_role) continue;
    const delegated = await routeMissionTeamDelegation(
      proposal.mission_id || missionId,
      proposal.team_role,
      proposal.task_summary || proposal.why || 'Delegated task from nerve-agent',
      senderAgentId
    );
    results.push(...delegated);
  }
  return results;
}

async function handleSlackConversationBypass(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const delegationResults = await routeSlackForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.parsedSlackPrompt,
    context.input.missionId
  );
  return buildDelegatedSurfaceConversationResult(delegationResults);
}

async function handlePresenceForcedBypass(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const delegationResults = await routeForcedDelegation(
    context.computedReceiver!,
    context.structuredQuery,
    context.input.senderAgentId,
    context.input.missionId
  );
  return buildDelegatedSurfaceConversationResult(delegationResults);
}

const SURFACE_RUNTIME_ROUTE_HANDLERS: SurfaceRuntimeRouteHandler[] = [
  {
    matches: (context) => {
      if (!context.compiledFlow) return false;
      const resolved = resolvedSurfaceIntent(context);
      return Boolean(resolved.routeFamily === 'pipeline' || resolved.routeFamily === 'mission');
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
    matches: (context) => {
      const resolved = resolvedSurfaceIntent(context);
      return resolved.routeFamily === 'direct_reply' && !context.computedReceiver;
    },
    handle: async (context) => {
      const resolved = resolvedSurfaceIntent(context);
      try {
        return await handleSurfaceQueryRoute(context, resolved);
      } catch (error: any) {
        return emptySurfaceResult(`Query route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) => {
      const resolved = resolvedSurfaceIntent(context);
      return resolved.routeFamily === 'browser_session';
    },
    handle: async (context) => {
      const query = structuredSurfaceQueryText(context);
      try {
        const delegationResults = await routeForcedDelegation(
          'browser-operator',
          query,
          context.input.senderAgentId,
          context.input.missionId
        );
        return buildDelegatedSurfaceConversationResult(delegationResults);
      } catch (error: any) {
        return emptySurfaceResult(`Browser route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) => Boolean(classifyTaskSessionIntent(structuredSurfaceQueryText(context))),
    handle: async (context) => {
      try {
        return await handleTaskSessionRoute(context);
      } catch (error: any) {
        return emptySurfaceResult(`Task-session route failed: ${error?.message || String(error)}`);
      }
    },
  },
  {
    matches: (context) =>
      Boolean(
        context.parsedSlackPrompt &&
        context.parsedSlackPrompt.executionMode === 'conversation' &&
        context.computedReceiver
      ),
    handle: handleSlackConversationBypass,
  },
  {
    matches: (context) =>
      context.input.agentId === 'presence-surface-agent' && Boolean(context.computedReceiver),
    handle: handlePresenceForcedBypass,
  },
];

export async function runSurfaceConversation(
  input: SurfaceConversationInput
): Promise<SurfaceConversationResult> {
  const forcedReceiver = normalizeSurfaceDelegationReceiver(input.forcedReceiver);
  const routedSurfaceInput = surfaceRoutingText(input);
  const surface = input.surface || surfaceChannelFromAgentId(input.agentId);
  const ruleBasedReceiver =
    forcedReceiver || deriveSurfaceDelegationReceiver(routedSurfaceInput.text, surface);
  const compiledFlow: UserIntentFlow | null = shouldCompileSurfaceIntent(
    input,
    routedSurfaceInput.text,
    ruleBasedReceiver
  )
    ? await compileUserIntentFlow({
        text: routedSurfaceInput.text,
        channel: input.agentId.includes('slack')
          ? 'slack'
          : input.agentId.includes('presence')
            ? 'presence'
            : 'surface',
      }).catch((error: any) => {
        logger.warn(
          `[SURFACE] Intent contract compilation failed: ${error?.message || String(error)}`
        );
        return null;
      })
    : null;

  if (compiledFlow?.clarificationPacket) {
    return attachRoutingDecision({
      text: formatClarificationPacket(compiledFlow.clarificationPacket),
      a2uiMessages: [],
      a2aMessages: [],
      delegationResults: [],
      approvalRequests: [],
      routingProposals: [],
      missionProposals: [],
      planningPackets: [],
    }, compiledFlow.routingDecision);
  }

  const computedReceiver: SurfaceDelegationReceiver | undefined =
    forcedReceiver ||
    ruleBasedReceiver ||
    (!forcedReceiver && compiledFlow
      ? resolveSurfaceConversationReceiver(undefined, compiledFlow, surface)
      : undefined);

  const structuredQuery = compiledFlow
    ? [
        input.query,
        '',
        'Governed execution brief:',
        JSON.stringify(compiledFlow.executionBrief, null, 2),
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
      ? routedSurfaceInput.parsedSlackPrompt ||
        (!input.surfaceText ? parseSlackSurfacePrompt(structuredQuery) : null)
      : null;

  const routeContext: SurfaceRuntimeRouteContext = {
    input,
    compiledFlow,
    resolvedIntent: resolveSurfaceIntent(routedSurfaceInput.text),
    computedReceiver,
    structuredQuery,
    parsedSlackPrompt,
  };
  const matchedRouteHandler = SURFACE_RUNTIME_ROUTE_HANDLERS.find((handler) =>
    handler.matches(routeContext)
  );
  if (matchedRouteHandler) {
    const routedResult = await matchedRouteHandler.handle(routeContext);
    return attachRoutingDecision(routedResult, compiledFlow?.routingDecision);
  }

  const handle = await ensureSurfaceAgent(input.agentId, input.cwd);
  const firstResponse = await handle.ask(structuredQuery);
  const firstBlocks = extractSurfaceBlocks(firstResponse);
  let delegationResults: SurfaceDelegationResult[] = [];
  const delegationFallbackText = buildDelegationFallbackText(structuredQuery);

  if (firstBlocks.a2aMessages.length > 0) {
    delegationResults = await processDelegations(
      firstBlocks.a2aMessages,
      input.senderAgentId,
      delegationFallbackText
    );
  } else if (input.missionId && input.teamRole) {
    delegationResults = await routeMissionTeamDelegation(
      input.missionId,
      input.teamRole,
      structuredQuery,
      input.senderAgentId
    );
  } else if (computedReceiver) {
    delegationResults = await routeForcedDelegation(
      computedReceiver,
      structuredQuery,
      input.senderAgentId,
      input.missionId
    );
  }

  if (delegationResults.length === 0) {
    return attachRoutingDecision(firstBlocks, compiledFlow?.routingDecision);
  }

  const successful = delegationResults.filter((result) => !result.error);
  const routingProposals = successful.flatMap((result) => {
    const text = typeof result.response === 'string' ? result.response : '';
    return extractSurfaceBlocks(text).routingProposals || [];
  });
  const routedDelegationResults =
    routingProposals.length > 0
      ? await routeNerveRoutingProposals(routingProposals, input.senderAgentId, input.missionId)
      : [];
  const finalDelegationResults = [...delegationResults, ...routedDelegationResults];

  if (successful.length === 0 && routedDelegationResults.length === 0) {
    return attachRoutingDecision({
      ...firstBlocks,
      delegationResults: finalDelegationResults,
      approvalRequests: firstBlocks.approvalRequests,
      routingProposals,
      missionProposals: firstBlocks.missionProposals,
      planningPackets: firstBlocks.planningPackets,
    }, compiledFlow?.routingDecision);
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

  return attachRoutingDecision({
    text: followUpBlocks.text,
    a2uiMessages: [...firstBlocks.a2uiMessages, ...followUpBlocks.a2uiMessages],
    a2aMessages: firstBlocks.a2aMessages,
    delegationResults: finalDelegationResults,
    approvalRequests: [...firstBlocks.approvalRequests, ...followUpBlocks.approvalRequests],
    routingProposals,
    missionProposals: [
      ...(firstBlocks.missionProposals || []),
      ...(followUpBlocks.missionProposals || []),
    ],
    planningPackets: [
      ...(firstBlocks.planningPackets || []),
      ...(followUpBlocks.planningPackets || []),
    ],
  }, compiledFlow?.routingDecision);
}

export async function runSurfaceMessageConversation(
  input: SurfaceConversationMessageInput
): Promise<SurfaceConversationResult> {
  return runSurfaceConversation(buildSurfaceConversationInput(input));
}
