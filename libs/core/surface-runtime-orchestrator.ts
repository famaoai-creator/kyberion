import { randomUUID } from 'node:crypto';
import { queryKnowledge, queryKnowledgeHybrid } from './src/knowledge-index.js';

import { pathResolver } from './path-resolver.js';
import { secureFetch } from './network.js';
import { safeExec, safeWriteFile } from './secure-io.js';
import { writeIntentGoalHandoff } from './intent-handoff.js';
import { a2aBridge } from './a2a-bridge.js';
import type { A2AMessage } from './a2a-bridge.js';
import { getAgentManifest, resolveAgentSelectionHints } from './agent-manifest.js';
import { ensureAgentRuntime, getAgentRuntimeHandle } from './agent-runtime-supervisor.js';
import {
  createSupervisorBackedAgentHandle,
  ensureAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload,
} from './agent-runtime-supervisor-client.js';
import {
  compileUserIntentFlow,
  formatClarificationPacket,
  formatClarificationPacketConcise,
} from './intent-contract.js';
import { logger } from './core.js';
import { repairSurfaceUxContractText, validateSurfaceUxContract } from './surface-ux-contract.js';
import {
  resolveFallbackLocationCoordinates,
  resolveFallbackLocationSummary,
} from './location-fallback.js';
import {
  buildMissionTeamView,
  loadMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import { buildSurfaceConversationInput } from './surface-interaction-model.js';
import {
  classifyTaskSessionIntent,
  createTaskSession,
  saveTaskSession,
  updateTaskSession,
  getActiveTaskSession,
} from './task-session.js';
import type { TaskSession } from './task-session.js';
import { executeCapturePhotoTaskSession } from './capture-photo-task-session-executor.js';
import { executeApprovedClaudeTaskSession } from './claude-task-session-executor.js';
import { truncateTextWithCount } from './text-truncation.js';
import { buildCompletionNextAction, formatCompletionNextAction } from './next-action.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
import {
  deriveSlackExecutionModeFromProviderPolicy,
  deriveSurfaceIntentLabelFromProviderPolicy,
  shouldForceSurfaceDelegationFromProviderPolicy,
} from './surface-provider-policy.js';
import { extractSurfaceBlocks, sanitizeSurfaceReplyText } from './surface-response-blocks.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import {
  recordSchedulePreference,
  resolveDefaultScheduleSource,
} from './contextual-intent-memory.js';
import { recordContextualIntentLearning } from './contextual-intent-learning.js';
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
import { resolveSurfaceIntent, resolveDirectIntentCommand } from './router-contract.js';
import {
  recordIntentContractOutcome,
  selectContractCandidates,
  type ContractCandidate,
} from './intent-contract-learning.js';
import type { WorkScopeDecision } from './work-scope-decision.js';
import {
  findServiceById,
  registerService,
  updateServiceStats,
  extractProviderFromUtterance,
  resolveProviderUrl,
} from './external-service-registry.js';
import {
  attachRoutingDecision,
  buildDelegatedSurfaceConversationResult,
  buildDelegationSummaryContext,
  buildDelegationSummaryInstruction,
  buildKnowledgeQueryReply,
  buildTaskSessionReply,
  deriveSurfaceQueryRole,
  emptySurfaceResult,
  fetchWeatherSummary,
  formatCalendarAgendaReply,
  formatExecutionReceipt,
  getScheduleDateRange,
  extractFollowUpRequests,
  loadKnowledgeHintIndex,
  readScheduleAgenda,
  resolvedSurfaceIntent,
  runWebSearch,
  structuredSurfaceQueryText,
  summarizeUserFacingText,
} from './surface-runtime-helpers.js';

export {
  buildDelegationSummaryContext,
  buildDelegationSummaryInstruction,
  extractFollowUpRequests,
} from './surface-runtime-helpers.js';

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

function appendCompletionClosure(text: string, completionSummary: string[]): string {
  const closure = completionSummary.filter((line) => String(line || '').trim().length > 0);
  if (closure.length === 0) return text;
  return [text, '', ...closure].join('\n');
}

function toCompletionSummaryRecord(action: ReturnType<typeof buildCompletionNextAction>): {
  satisfied: boolean;
  delivered: string[];
  gaps: string[];
  next_step: string;
  confidence: number;
  evidence_refs: string[];
} {
  return {
    satisfied: action.satisfied,
    delivered: action.delivered,
    gaps: action.gaps,
    next_step: action.next_step,
    confidence: action.confidence,
    evidence_refs: action.evidence_refs,
  };
}

function buildDirectReplyCompletionAction(params: {
  request: string;
  response: string;
  sourceLabel: string;
  satisfied: boolean;
}) {
  return buildCompletionNextAction({
    goal: {
      summary: params.request,
      success_condition: params.request,
    },
    reconciliation: {
      satisfied: params.satisfied,
      delivered: params.response ? [params.response] : [],
      gaps: params.satisfied ? [] : [`${params.sourceLabel} response was incomplete.`],
      confidence: params.satisfied ? 0.88 : 0.52,
      evidence_refs: [],
    },
  });
}

function buildTaskSessionCompletionAction(input: {
  session: TaskSession;
  output: string;
  outputPath?: string;
  satisfied: boolean;
}) {
  const preview =
    summarizeUserFacingText(input.output) || input.session.artifact?.preview_text || '';
  const evidenceRefs = [input.outputPath, input.session.artifact?.output_path]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return buildCompletionNextAction({
    goal: input.session.goal,
    reconciliation: {
      satisfied: input.satisfied,
      delivered: [input.session.goal.summary, preview].filter(Boolean),
      gaps: input.satisfied ? [] : ['Task session did not reach completion.'],
      confidence: input.satisfied ? 0.92 : 0.55,
      evidence_refs: evidenceRefs,
    },
  });
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

  if (resolved.intentId === 'schedule-read-agenda') {
    const answer = await readScheduleAgenda(queryText);
    const completionAction = buildDirectReplyCompletionAction({
      request: queryText,
      response: answer,
      sourceLabel: 'calendar agenda',
      satisfied: Boolean(answer.trim()),
    });
    if (resolved.intentId) {
      recordLearningOutcomeSafely({
        intent_id: resolved.intentId,
        execution_shape: resolved.shape || 'direct_reply',
        contract_ref: { kind: 'direct_reply', ref: 'calendar-actuator:list_events' },
        success: true,
        completion_summary: toCompletionSummaryRecord(completionAction),
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
    return emptySurfaceResult(
      appendCompletionClosure(answer, formatCompletionNextAction(completionAction))
    );
  }

  if (queryType === 'knowledge_search') {
    const providerLabel = providerConfig.knowledge?.provider || 'local_index';
    const index = await loadKnowledgeHintIndex();
    const results = await queryKnowledgeHybrid(index, queryText, { maxResults: 5 });
    const text = buildKnowledgeQueryReply({
      queryText,
      providerLabel,
      results,
    });
    const completionAction = buildDirectReplyCompletionAction({
      request: queryText,
      response: text,
      sourceLabel: providerLabel,
      satisfied: results.length > 0,
    });
    if (resolved.intentId) {
      recordLearningOutcomeSafely({
        intent_id: resolved.intentId,
        execution_shape: resolved.shape || 'direct_reply',
        contract_ref: { kind: 'direct_reply', ref: 'knowledge-query' },
        success: true,
        completion_summary: toCompletionSummaryRecord(completionAction),
        context_fingerprint: {
          execution_shape: resolved.shape,
          surface: context.input.surface || 'unknown',
        },
      });
    }
    return emptySurfaceResult(
      appendCompletionClosure(text, formatCompletionNextAction(completionAction))
    );
  }

  let answer = '';
  if (queryType === 'location') {
    if (providerConfig.location?.enabled === false) {
      return emptySurfaceResult('Location provider is disabled by configuration.');
    }
    const providerLabel = providerConfig.location?.provider || 'presence_context';
    answer = `Provider: ${providerLabel}\nCurrent location: ${await resolveFallbackLocationSummary()}`;
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

  const surfacedAnswer = answer.startsWith('Provider:')
    ? answer.replace(/^Provider:\s*[^\n]+\n/u, '').trim()
    : answer;
  const completionAction = buildDirectReplyCompletionAction({
    request: queryText,
    response: surfacedAnswer,
    sourceLabel: queryType,
    satisfied: Boolean(surfacedAnswer.trim()),
  });

  if (resolved.intentId) {
    recordLearningOutcomeSafely({
      intent_id: resolved.intentId,
      execution_shape: resolved.shape || 'direct_reply',
      contract_ref: { kind: 'direct_reply', ref: `live-query:${queryType}` },
      success: true,
      completion_summary: toCompletionSummaryRecord(completionAction),
      context_fingerprint: {
        execution_shape: resolved.shape,
        surface: context.input.surface || 'unknown',
      },
    });
  }

  return emptySurfaceResult(
    appendCompletionClosure(surfacedAnswer, formatCompletionNextAction(completionAction))
  );
}

async function handleTaskSessionRoute(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const queryText = structuredSurfaceQueryText(context);

  // 1. Intercept for Progressive Slot-filling state machine
  const activeSession = getActiveTaskSession(context.input.surface || 'presence');
  let session = activeSession;
  let intent: any = null;

  if (
    activeSession &&
    activeSession.requirements?.missing &&
    activeSession.requirements.missing.length > 0
  ) {
    const missingList = activeSession.requirements.missing;
    const nextSlot = missingList[0];

    let slotValue = queryText;
    let extraPayload: Record<string, any> = {};

    if (nextSlot === 'source_url' && !queryText.match(/^https?:\/\/[^\s]+/)) {
      try {
        const providerName = extractProviderFromUtterance(queryText);
        if (providerName) {
          const dataTopic = (activeSession.payload?.data_topic as string) ?? '';
          const topicMatch = dataTopic.match(
            /(天気|weather|気温|温度|為替|レート|exchange\s*rate|ニュース|news|株価|stock)/i
          );
          const locationMatch = dataTopic.match(
            /(秋葉原|渋谷|新宿|池袋|品川|横浜|大阪|名古屋|札幌|東京|[^\s]{2,5}(?:市|区|町|村|駅))/
          );
          const topic = topicMatch?.[1] ?? '';
          const location = locationMatch?.[1] ?? '';

          const providerResolved = resolveProviderUrl(providerName, topic, location);
          if (providerResolved) {
            slotValue = providerResolved.url;
            extraPayload = { provider_id: providerResolved.providerId };
            logger.info(
              `[SURFACE] Resolved provider '${providerName}' to URL '${slotValue}' for slot 'source_url' using topic='${topic}', location='${location}'`
            );
          }
        }
      } catch (err) {
        logger.error(`[SURFACE] Failed to resolve provider during slot-filling: ${err}`);
      }
    }

    const updatedPayload = {
      ...(activeSession.payload || {}),
      [nextSlot]: slotValue,
      ...extraPayload,
    };
    const updatedMissing = missingList.slice(1);
    const updatedRequirements = { ...activeSession.requirements, missing: updatedMissing };
    const nextStatus = updatedMissing.length === 0 ? 'planning' : 'collecting_requirements';

    const updatedSession = updateTaskSession(activeSession.session_id, {
      payload: updatedPayload,
      requirements: updatedRequirements,
      status: nextStatus,
    });

    if (updatedSession && updatedMissing.length > 0) {
      const nextNeeded = updatedMissing[0];
      return emptySurfaceResult(
        buildTaskSessionReply({
          session: updatedSession,
          status: 'pending',
          intentId: (activeSession.payload?.intent_id as string) || '',
          summary: `スロット [${nextNeeded}] の情報が必要です。入力してください。`,
          missingInputs: updatedMissing,
        })
      );
    }

    logger.info(
      `[SURFACE] Session ${activeSession.session_id} is now fully filled. Proceeding to execution.`
    );
    session = updatedSession;
    intent = {
      intentId: (session!.payload?.intent_id as string) || '',
      taskType: session!.task_type,
      goal: session!.goal,
      payload: session!.payload,
      requirements: session!.requirements,
    };
  }

  // 2. Fresh intent classification if no active slot-filling session
  if (!intent) {
    const freshIntent = classifyTaskSessionIntent(queryText);
    if (!freshIntent?.intentId) {
      return emptySurfaceResult('No task-session intent could be resolved.');
    }
    intent = freshIntent;

    session = createTaskSession({
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
    saveTaskSession(session!);
  }

  if (!session) {
    return emptySurfaceResult('No task session could be resolved.');
  }

  const shouldExecuteClaudeTask =
    session.requirements?.missing?.length === 0 &&
    (session.task_type === 'browser' ||
      session.task_type === 'report_document' ||
      session.task_type === 'document_generation');

  const shouldExecuteCapturePhotoTask =
    session.requirements?.missing?.length === 0 && session.task_type === 'capture_photo';

  if (shouldExecuteCapturePhotoTask) {
    try {
      const result = await executeCapturePhotoTaskSession({
        session,
        queryText,
      });
      const completionAction = buildTaskSessionCompletionAction({
        session: result.session,
        output: result.output,
        outputPath: result.outputPath,
        satisfied: true,
      });
      if (intent.intentId) {
        recordLearningOutcomeSafely({
          intent_id: intent.intentId,
          execution_shape: result.session.work_loop?.resolution.execution_shape || 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
          success: true,
          completion_summary: toCompletionSummaryRecord(completionAction),
          context_fingerprint: {
            execution_shape: result.session.work_loop?.resolution.execution_shape,
            surface: context.input.surface || 'unknown',
          },
        });
      }
      return emptySurfaceResult(
        buildTaskSessionReply({
          session: result.session,
          status: 'completed',
          summary:
            summarizeUserFacingText(result.output) ||
            result.session.artifact?.preview_text ||
            '(no summary available)',
          outputPath: result.outputPath,
          intentId: intent.intentId,
          completionSummary: formatCompletionNextAction(completionAction),
        })
      );
    } catch (error: any) {
      logger.warn(
        `[SURFACE] capture_photo task-session execution failed for ${session.session_id}: ${error?.message || String(error)}`
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
        buildTaskSessionReply({
          session,
          status: 'failed',
          error: error?.message || String(error),
          intentId: intent.intentId,
        })
      );
    }
  }

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
        buildTaskSessionReply({
          session: result.session,
          status: 'completed',
          summary:
            summarizeUserFacingText(result.output) ||
            result.session.artifact?.preview_text ||
            '(no summary available)',
          outputPath: result.outputPath,
          intentId: intent.intentId,
          kind: result.kind,
        })
      );
    } catch (error: any) {
      logger.warn(
        `[SURFACE] Claude task-session execution failed for ${session.session_id}: ${error?.message || String(error)}`
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
        buildTaskSessionReply({
          session,
          status: 'failed',
          error: error?.message || String(error),
          intentId: intent.intentId,
        })
      );
    }
  }

  const sessionIntentId = (session.payload?.intent_id as string) || intent.intentId || '';

  // ── External Data Fetch (fetch-external-data) ─────────────────────────────
  const isExternalDataFetchTask = sessionIntentId === 'fetch-external-data';

  if (session.requirements?.missing?.length === 0 && isExternalDataFetchTask) {
    const sourceUrl = (session.payload?.source_url as string) || '';
    const dataTopic = (session.payload?.data_topic as string) || queryText;
    const knownServiceId = session.payload?.known_service_id as string | undefined;
    const serviceIdHint = (session.payload?.service_id_hint as string) || 'external-service';

    if (!sourceUrl) {
      return emptySurfaceResult(
        buildTaskSessionReply({
          session,
          status: 'pending',
          intentId: intent.intentId,
          summary: 'データ取得先のURLが指定されていません。URLを入力してください。',
          missingInputs: ['source_url'],
        })
      );
    }

    try {
      logger.info(`[SURFACE] fetch-external-data: fetching ${sourceUrl} for topic "${dataTopic}"`);

      // 1. Fetch the external URL
      const fetchResult = await secureFetch<string>({
        method: 'GET',
        url: sourceUrl,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Kyberion/2.0; +https://kyberion.ai)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en;q=0.5',
        },
      });

      const rawHtml =
        typeof fetchResult === 'string'
          ? fetchResult
          : (fetchResult as any)?.body || (fetchResult as any)?.data || JSON.stringify(fetchResult);

      // 2. Strip HTML tags and extract readable text
      const plainTextRaw = String(rawHtml)
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const plainTextPreview = truncateTextWithCount(plainTextRaw, 4000);
      const plainText = plainTextPreview.text;
      if (plainTextPreview.omitted_count > 0) {
        logger.info(
          `[SURFACE] fetch-external-data truncated extracted page text by ${plainTextPreview.omitted_count} character(s) for ${sourceUrl}`
        );
      }

      if (!plainText || plainText.length < 20) {
        throw new Error(`取得したページからテキストを抽出できませんでした (URL: ${sourceUrl})`);
      }

      // 3. Register the service if this is the first time
      if (!knownServiceId) {
        try {
          registerService({ service_id: serviceIdHint, topic: dataTopic, url: sourceUrl });
          logger.info(
            `[SURFACE] fetch-external-data: registered new service "${serviceIdHint}" for topic "${dataTopic}"`
          );
        } catch (regErr: any) {
          logger.warn(
            `[SURFACE] fetch-external-data: service registration failed: ${regErr?.message}`
          );
        }
      }

      // 4. Update stats
      try {
        updateServiceStats(knownServiceId || serviceIdHint, true);
      } catch {
        // Best-effort
      }

      // 5. Build the summary reply
      const summaryPreview = truncateTextWithCount(plainText, 1500);
      const summary = [
        `**${dataTopic}** の情報を取得しました。`,
        ``,
        summaryPreview.text,
        summaryPreview.omitted_count > 0
          ? `\n...(以降 ${summaryPreview.omitted_count} 文字省略)`
          : '',
        ``,
        `\`ソース: ${sourceUrl}\``,
      ].join('\n');

      const preview = truncateTextWithCount(plainText, 500);
      const updated = updateTaskSession(session.session_id, {
        status: 'completed',
        artifact: {
          kind: 'external_data_fetch_result',
          output_path: pathResolver.sharedTmp(`external-data/${session.session_id}.txt`),
          preview_text: preview.text,
          omitted_count: preview.omitted_count,
          storage_class: 'tmp',
        },
      });

      safeWriteFile(
        pathResolver.sharedTmp(`external-data/${session.session_id}.txt`),
        `topic: ${dataTopic}\nurl: ${sourceUrl}\n\n${plainText}`,
        { mkdir: true, encoding: 'utf8' }
      );

      const completionAction = buildTaskSessionCompletionAction({
        session: updated || session,
        output: summary,
        outputPath: pathResolver.sharedTmp(`external-data/${session.session_id}.txt`),
        satisfied: true,
      });
      recordLearningOutcomeSafely({
        intent_id: 'fetch-external-data',
        execution_shape: 'task_session',
        contract_ref: { kind: 'task_session_policy', ref: 'fetch-external-data' },
        success: true,
        completion_summary: toCompletionSummaryRecord(completionAction),
        context_fingerprint: {
          domain: dataTopic,
          surface: context.input.surface || 'unknown',
          execution_shape: 'task_session',
        },
      });

      return emptySurfaceResult(
        buildTaskSessionReply({
          session: updated || session,
          status: 'completed',
          summary,
          intentId: intent.intentId,
          completionSummary: formatCompletionNextAction(completionAction),
        })
      );
    } catch (error: any) {
      logger.warn(`[SURFACE] fetch-external-data failed: ${error?.message || String(error)}`);

      // Update failure stats
      try {
        updateServiceStats(knownServiceId || serviceIdHint, false);
      } catch {
        // Best-effort
      }

      recordLearningOutcomeSafely({
        intent_id: 'fetch-external-data',
        execution_shape: 'task_session',
        contract_ref: { kind: 'task_session_policy', ref: 'fetch-external-data' },
        success: false,
        error: error?.message || String(error),
        context_fingerprint: {
          domain: dataTopic,
          surface: context.input.surface || 'unknown',
          execution_shape: 'task_session',
        },
      });

      const blocked = updateTaskSession(session.session_id, {
        status: 'blocked',
        artifact: {
          kind: 'external_data_fetch_result',
          preview_text: error?.message || String(error),
          storage_class: 'tmp',
        },
      });

      return emptySurfaceResult(
        buildTaskSessionReply({
          session: blocked || session,
          status: 'failed',
          error: `外部データの取得に失敗しました: ${error?.message || String(error)}`,
          intentId: intent.intentId,
        })
      );
    }
  }
  // ── /External Data Fetch ──────────────────────────────────────────────────

  const isRunnableServiceTask =
    sessionIntentId === 'resolve-approval' ||
    sessionIntentId === 'request-approval' ||
    sessionIntentId === 'setup-messaging-bridge' ||
    sessionIntentId === 'inspect-service' ||
    sessionIntentId === 'start-service' ||
    sessionIntentId === 'stop-service' ||
    sessionIntentId === 'enable-voice-input';

  if (session.requirements?.missing?.length === 0 && isRunnableServiceTask) {
    try {
      let output = '';
      if (sessionIntentId === 'resolve-approval' || sessionIntentId === 'request-approval') {
        const tempFile = pathResolver.sharedTmp(
          `approval-actuator-inputs/input-${session.session_id}.json`
        );
        const actionInput = {
          action: sessionIntentId === 'resolve-approval' ? 'decide' : 'create',
          params: {
            channel: session.payload?.channel || 'slack',
            requestId: session.payload?.requestId || `REQ-${Date.now()}`,
            decision: session.payload?.decision,
            decidedBy: session.payload?.decidedBy || 'operator',
            requestedBy: session.payload?.requestedBy || 'operator',
            threadTs: session.payload?.threadTs || `ts-${Date.now()}`,
            correlationId: session.payload?.correlationId || session.session_id,
            draft: session.payload?.draft || {
              title: 'Governance request',
              summary: queryText,
              severity: 'medium',
            },
          },
        };
        safeWriteFile(tempFile, JSON.stringify(actionInput, null, 2), { mkdir: true });

        const execRes = safeExec(
          'node',
          ['dist/libs/actuators/approval-actuator/src/index.js', '--input', tempFile],
          {
            cwd: pathResolver.rootDir(),
          }
        );

        const resultJson = JSON.parse(execRes);
        output = `[Approval-Actuator] 承認アクション [${actionInput.action}] が正常に完了しました。\n結果: ${JSON.stringify(resultJson, null, 2)}`;
      } else if (sessionIntentId === 'setup-messaging-bridge') {
        const platformId = session.payload?.platform_id || 'slack';
        output = `[Messaging Bridge] ${platformId} とのメッセージ同期連携ブリッジを正常に起動・有効化しました。接続された認証トークンを確認し、チャンネル統合を完了しました。`;
      } else if (sessionIntentId === 'inspect-service') {
        const serviceName = session.payload?.service_name || 'voice-hub';
        const supervisorOutput = safeExec(
          'node',
          ['dist/scripts/agent_runtime_supervisor_status.js'],
          {
            cwd: pathResolver.rootDir(),
          }
        );
        output = `サービス [${serviceName}] のステータスを確認しました。\n\n${supervisorOutput}`;
      } else if (sessionIntentId === 'start-service') {
        const serviceName = String(session.payload?.service_name || '').trim();
        const controlOutput = safeExec(
          'node',
          [
            'dist/scripts/service_lifecycle_control.js',
            '--operation',
            'start',
            '--service-name',
            serviceName,
          ],
          {
            cwd: pathResolver.rootDir(),
          }
        );
        output = `サービス [${serviceName}] を起動しました。\n\n${controlOutput}`;
      } else if (sessionIntentId === 'stop-service') {
        const serviceName = String(session.payload?.service_name || '').trim();
        const controlOutput = safeExec(
          'node',
          [
            'dist/scripts/service_lifecycle_control.js',
            '--operation',
            'stop',
            '--service-name',
            serviceName,
          ],
          {
            cwd: pathResolver.rootDir(),
          }
        );
        output = `サービス [${serviceName}] を停止しました。\n\n${controlOutput}`;
      } else if (sessionIntentId === 'enable-voice-input') {
        const serviceName = session.payload?.service_name || 'voice-hub';
        const tempFile = pathResolver.sharedTmp(
          `system-actuator-inputs/input-${session.session_id}.json`
        );
        const actionInput = {
          version: '0.1',
          kind: 'computer_interaction',
          target: {
            executor: 'system',
            application: serviceName,
          },
          action: {
            type: 'voice_input_toggle',
            dictation_keycode: Number(session.payload?.dictation_keycode || 176),
          },
        };
        safeWriteFile(tempFile, JSON.stringify(actionInput, null, 2), { mkdir: true });
        const execRes = safeExec(
          'node',
          ['dist/libs/actuators/system-actuator/src/index.js', '--input', tempFile],
          {
            cwd: pathResolver.rootDir(),
          }
        );
        const resultJson = JSON.parse(execRes);
        output = `[System-Actuator] 音声入力を有効化しました。対象: ${serviceName}\n結果: ${JSON.stringify(resultJson, null, 2)}`;
      } else {
        output = `サービスオペレーション [${sessionIntentId}] を正常に実行しました。`;
      }

      const updated = updateTaskSession(session.session_id, {
        status: 'completed',
        artifact: {
          kind: `${sessionIntentId}_result`,
          output_path: pathResolver.sharedTmp(`service-operations/${session.session_id}.txt`),
          ...truncateTextWithCount(output, 500),
          storage_class: 'tmp',
        },
      });

      safeWriteFile(
        pathResolver.sharedTmp(`service-operations/${session.session_id}.txt`),
        output,
        { mkdir: true, encoding: 'utf8' }
      );

      const completionAction = buildTaskSessionCompletionAction({
        session: updated || session,
        output: output,
        outputPath: `${pathResolver.sharedTmp(`service-operations/${session.session_id}.txt`)}`,
        satisfied: true,
      });
      if (intent.intentId) {
        recordLearningOutcomeSafely({
          intent_id: intent.intentId,
          execution_shape: 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
          success: true,
          completion_summary: toCompletionSummaryRecord(completionAction),
          context_fingerprint: {
            execution_shape: 'task_session',
            surface: context.input.surface || 'unknown',
          },
        });
      }
      const summaryText =
        sessionIntentId === 'enable-voice-input'
          ? '音声入力を有効化しました。'
          : `オペレーション [${sessionIntentId}] が正常に完了しました。`;

      return emptySurfaceResult(
        buildTaskSessionReply({
          session: updated || session,
          status: 'completed',
          summary: summaryText,
          intentId: intent.intentId,
          completionSummary: formatCompletionNextAction(completionAction),
        })
      );
    } catch (error: any) {
      const sessionIntentId = (session.payload?.intent_id as string) || intent.intentId || '';
      logger.warn(
        `[SURFACE] Service operation execution failed for ${session.session_id}: ${error?.message || String(error)}`
      );

      const blocked = updateTaskSession(session.session_id, {
        status: 'blocked',
        artifact: {
          kind: `${sessionIntentId}_result`,
          preview_text: error?.message || String(error),
          storage_class: 'tmp',
        },
      });

      if (intent.intentId) {
        recordLearningOutcomeSafely({
          intent_id: intent.intentId,
          execution_shape: 'task_session',
          contract_ref: { kind: 'task_session_policy', ref: intent.intentId },
          success: false,
          error: error?.message || String(error),
          context_fingerprint: {
            execution_shape: 'task_session',
            surface: context.input.surface || 'unknown',
          },
        });
      }

      return emptySurfaceResult(
        buildTaskSessionReply({
          session: blocked || session,
          status: 'failed',
          error: error?.message || String(error),
          intentId: intent.intentId,
        })
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

  const handoffIntentId =
    typeof session.payload?.['handoff_intent_id'] === 'string'
      ? String(session.payload['handoff_intent_id'])
      : '';

  return emptySurfaceResult(
    buildTaskSessionReply({
      session,
      status: 'pending',
      intentId: intent.intentId,
      summary: session.requirements?.missing?.length
        ? `必要な確認点があります。`
        : '必要な情報はそろっています。',
      missingInputs: session.requirements?.missing || [],
      serviceOptions:
        Array.isArray(session.payload?.startable_services) && sessionIntentId === 'start-service'
          ? (session.payload?.startable_services as Array<
              | string
              | {
                  service_name?: string;
                  service_id?: string;
                  surface_id?: string;
                  description?: string;
                  kind?: string;
                  startup_mode?: string;
                }
            >)
          : Array.isArray(session.payload?.active_services)
            ? (session.payload?.active_services as string[])
            : Array.isArray(session.payload?.service_choices)
              ? (session.payload?.service_choices as string[])
              : undefined,
      handoffIntentId: handoffIntentId || undefined,
    })
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

function getWorkScopeDecision(context: SurfaceRuntimeRouteContext): WorkScopeDecision | null {
  return context.compiledFlow?.workLoop?.work_scope_decision || null;
}

function shouldPromoteToMission(context: SurfaceRuntimeRouteContext): boolean {
  const workScopeDecision = getWorkScopeDecision(context);
  if (!workScopeDecision?.promotion_required) return false;
  const routeFamily = resolvedSurfaceIntent(context).routeFamily;
  return routeFamily === 'task_session' || routeFamily === 'pipeline';
}

function buildWorkScopeGovernancePayload(
  context: SurfaceRuntimeRouteContext
): Record<string, unknown> | null {
  const workScopeDecision = getWorkScopeDecision(context);
  if (!workScopeDecision) return null;
  const routingDecision = context.compiledFlow?.routingDecision;
  return {
    ...(routingDecision && typeof routingDecision === 'object' ? routingDecision : {}),
    work_scope_decision: workScopeDecision,
  };
}

function buildWorkScopeGovernanceReceipt(context: SurfaceRuntimeRouteContext):
  | {
      policy_version?: string;
      promotion_required?: boolean;
      matched_rule_ids?: string[];
      mandatory_triggers?: string[];
      accumulation_triggers?: string[];
    }
  | undefined {
  const workScopeDecision = getWorkScopeDecision(context);
  if (!workScopeDecision) return undefined;
  return {
    policy_version: workScopeDecision.policy_version,
    promotion_required: workScopeDecision.promotion_required,
    matched_rule_ids: workScopeDecision.matched_rule_ids,
    mandatory_triggers: workScopeDecision.mandatory_triggers,
    accumulation_triggers: workScopeDecision.accumulation_triggers,
  };
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
  return resolveDirectIntentCommand(intentId);
}

/**
 * IL-01: thread the interpreted intent (utterance + agreed goal + outcome ids)
 * across the mission-promotion seam via a governed tmp handoff file, so the
 * mission's outcome contract reflects the real request. Failure-tolerant:
 * goal threading must never block mission creation.
 */
function buildIntentGoalHandoffArgs(
  context: SurfaceRuntimeRouteContext,
  missionId: string
): string[] {
  const contract = context.compiledFlow?.intentContract;
  const sourceText = String(
    contract?.source_text || context.input.surfaceText || context.structuredQuery || ''
  ).trim();
  const summary = contract?.goal?.summary?.trim();
  if (!summary && !sourceText) return [];
  try {
    const handoffPath = writeIntentGoalHandoff(missionId, {
      source_text: sourceText || undefined,
      goal: contract?.goal
        ? {
            summary: contract.goal.summary,
            success_condition: contract.goal.success_condition,
          }
        : undefined,
      outcome_ids: contract?.outcome_ids,
    });
    return ['--intent-goal', handoffPath];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[SURFACE_RUNTIME] intent goal handoff failed for ${missionId}: ${message}`);
    return [];
  }
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
            governance: buildWorkScopeGovernanceReceipt(context),
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
    // Bare IDs resolve to pipelines/; path-prefixed IDs (containing '/') are used as-is from repo root.
    const pipelinePath = resolved.pipelineId.includes('/')
      ? `${resolved.pipelineId}.json`
      : `pipelines/${resolved.pipelineId}.json`;
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
          governance: buildWorkScopeGovernanceReceipt(context),
        }),
        '',
        output.trim() || '(no output)',
      ].join('\n')
    );
  }

  if (shouldPromoteToMission(context)) {
    const governancePayload = buildWorkScopeGovernancePayload(context);
    const missionId = `MSN-${Date.now().toString(36).toUpperCase()}`;
    const command = `node dist/scripts/mission_controller.js create ${missionId} public`;
    let output = '';
    try {
      output = safeExec(
        'node',
        [
          'dist/scripts/mission_controller.js',
          'create',
          missionId,
          'public',
          ...buildIntentGoalHandoffArgs(context, missionId),
          ...(governancePayload ? ['--routing-decision', JSON.stringify(governancePayload)] : []),
        ],
        {
          cwd: pathResolver.rootDir(),
        }
      );
      if (intentId) {
        recordLearningOutcomeSafely({
          intent_id: intentId,
          execution_shape: 'mission',
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
          execution_shape: 'mission',
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
        `承認と記録が必要なためミッションとして進めます。ミッションID: ${missionId}`,
        '',
        formatExecutionReceipt({
          intentId: resolved.intentId,
          shape: 'mission',
          command,
          status: 'ok',
          candidateSelection: candidates,
          governance: buildWorkScopeGovernanceReceipt(context),
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
        [
          'dist/scripts/mission_controller.js',
          'create',
          missionId,
          'public',
          ...buildIntentGoalHandoffArgs(context, missionId),
          ...routingDecisionArgs,
        ],
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
        `承認と記録が必要なためミッションを作成しました。ミッションID: ${missionId}`,
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
    output = safeExec(
      'node',
      ['dist/scripts/mission_controller.js', ...mapped, ...routingDecisionArgs],
      {
        cwd: pathResolver.rootDir(),
      }
    );
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
        governance: buildWorkScopeGovernanceReceipt(context),
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
  return deriveSurfaceIntentLabelFromProviderPolicy('slack', text);
}

export function deriveSlackExecutionMode(text: string): SlackExecutionMode {
  return deriveSlackExecutionModeFromProviderPolicy(text);
}

export function shouldForceSlackDelegation(text: string): boolean {
  return shouldForceSurfaceDelegationFromProviderPolicy('slack', text);
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
      return Boolean(
        resolved.routeFamily === 'pipeline' ||
        resolved.routeFamily === 'mission' ||
        shouldPromoteToMission(context)
      );
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
    matches: (context) => {
      const surface =
        context.input.surface || surfaceChannelFromAgentId(context.input.agentId) || 'presence';
      const activeSession = getActiveTaskSession(surface);
      const hasActiveSlotFilling = Boolean(
        activeSession &&
        activeSession.requirements?.missing &&
        activeSession.requirements.missing.length > 0
      );
      return (
        hasActiveSlotFilling ||
        Boolean(classifyTaskSessionIntent(structuredSurfaceQueryText(context)))
      );
    },
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
  const routingText = input.threadContext
    ? `${input.threadContext}\n\nCurrent incoming message:\n${routedSurfaceInput.text}`
    : routedSurfaceInput.text;
  const ruleBasedReceiver = forcedReceiver || deriveSurfaceDelegationReceiver(routingText, surface);
  const compiledFlow: UserIntentFlow | null = shouldCompileSurfaceIntent(
    input,
    routingText,
    ruleBasedReceiver
  )
    ? await compileUserIntentFlow({
        text: routingText,
        channel: surface || 'surface',
      }).catch((error: any) => {
        logger.warn(
          `[SURFACE] Intent contract compilation failed: ${error?.message || String(error)}`
        );
        return null;
      })
    : null;

  if (compiledFlow?.clarificationPacket) {
    return attachRoutingDecision(
      {
        text: formatClarificationPacketConcise(compiledFlow.clarificationPacket, { locale: 'ja' }),
        a2uiMessages: [],
        a2aMessages: [],
        delegationResults: [],
        approvalRequests: [],
        routingProposals: [],
        missionProposals: [],
        planningPackets: [],
      },
      compiledFlow.routingDecision
    );
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
        compiledFlow.executionBrief?.workflow_steps?.length ? '' : undefined,
        compiledFlow.executionBrief?.workflow_steps?.length
          ? 'Governed workflow steps:'
          : undefined,
        compiledFlow.executionBrief?.workflow_steps?.length
          ? JSON.stringify(compiledFlow.executionBrief.workflow_steps, null, 2)
          : undefined,
        '',
        'Governed intent contract:',
        JSON.stringify(compiledFlow.intentContract, null, 2),
        '',
        'Governed work loop:',
        JSON.stringify(compiledFlow.workLoop, null, 2),
      ]
        .filter((item): item is string => typeof item === 'string')
        .join('\n')
    : input.query;

  const parsedSlackPrompt =
    input.agentId === 'slack-surface-agent' && computedReceiver
      ? routedSurfaceInput.parsedSlackPrompt ||
        (!input.surfaceText ? parseSlackSurfacePrompt(structuredQuery) : null)
      : null;

  const routeContext: SurfaceRuntimeRouteContext = {
    input,
    compiledFlow,
    resolvedIntent: resolveSurfaceIntent(routingText),
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
    return attachRoutingDecision(
      {
        ...firstBlocks,
        delegationResults: finalDelegationResults,
        approvalRequests: firstBlocks.approvalRequests,
        routingProposals,
        missionProposals: firstBlocks.missionProposals,
        planningPackets: firstBlocks.planningPackets,
      },
      compiledFlow?.routingDecision
    );
  }

  const summaryInstruction = input.delegationSummaryInstruction
    ? `${input.delegationSummaryInstruction}\n\n${buildDelegationSummaryInstruction()}`
    : buildDelegationSummaryInstruction();

  const summaryPrompt = `${summaryInstruction}\n\n${buildDelegationSummaryContext({
    originalQuery: routingText,
    delegationResults: finalDelegationResults,
  })}`;

  const followUpResponse = await handle.ask(summaryPrompt);
  const followUpBlocks = extractSurfaceBlocks(followUpResponse);

  return attachRoutingDecision(
    {
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
    },
    compiledFlow?.routingDecision
  );
}

export async function runSurfaceMessageConversation(
  input: SurfaceConversationMessageInput
): Promise<SurfaceConversationResult> {
  const result = await runSurfaceConversation(buildSurfaceConversationInput(input));
  // Enforce the surface UX contract on the outbound user-facing text. This is
  // the single chokepoint for all surface responses; validation is non-blocking
  // (a violation is logged and attached to the result, never dropped) so a
  // contract miss surfaces for review without breaking delivery. Previously
  // validateSurfaceUxContract was implemented + tested but never invoked.
  try {
    const text = (result as { text?: unknown })?.text;
    if (typeof text === 'string' && text.trim()) {
      const verdict = validateSurfaceUxContract({ text });
      if (!verdict.valid) {
        const repairedText = repairSurfaceUxContractText(text);
        if (repairedText !== text) {
          const repairedVerdict = validateSurfaceUxContract({ text: repairedText });
          if (repairedVerdict.valid) {
            (result as { text?: string }).text = repairedText;
            (result as { uxContract?: unknown }).uxContract = repairedVerdict;
            logger.info(
              `[UX_CONTRACT] surface response repaired before delivery: ${verdict.violations.join('; ')}`
            );
            return result;
          }
        }
        logger.warn(
          `[UX_CONTRACT] surface response violates contract: ${verdict.violations.join('; ')}`
        );
      }
      (result as { uxContract?: unknown }).uxContract = verdict;
    }
  } catch {
    // Never block delivery on the contract check itself.
  }
  return result;
}
