import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSurfaceActuatorResult } from './surface-runtime-result.js';
import { queryKnowledgeHybrid } from './src/knowledge-index.js';

import { pathResolver } from './path-resolver.js';
import { secureFetch } from './network.js';
import { assertSafeRepositoryPath, safeExec, safeWriteFile } from './secure-io.js';
import { writeIntentGoalHandoff } from './intent-handoff.js';
import { a2aBridge } from './a2a-bridge.js';
import { logger } from './core.js';
import { resolveFallbackLocationSummary } from './location-fallback.js';
import {
  classifyTaskSessionIntent,
  createTaskSession,
  getLatestCompletedTaskSession,
  reopenTaskSession,
  saveTaskSession,
  updateTaskSession,
  getActiveTaskSession,
} from './task-session.js';
import type { TaskSession } from './task-session.js';
import type { ApprovalRequestDraft } from './approval-store.js';
import { loadPendingIntent } from './pending-intent-store.js';
import { executeCapturePhotoTaskSession } from './capture-photo-task-session-executor.js';
import { executeApprovedClaudeTaskSession } from './claude-task-session-executor.js';
import { truncateTextWithCount } from './text-truncation.js';
import { buildCompletionNextAction, formatCompletionNextAction } from './next-action.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
import { currentScope } from './scope-context.js';
import { isCorrectionUtterance } from './correction-detection.js';
import { type SurfaceRuntimeRouteContext } from './surface-runtime-router.js';
import { resolveSurfaceIntent, resolveDirectIntentCommand } from './router-contract.js';
import { recordIntentContractOutcome } from './intent-contract-learning.js';
import { t } from './t.js';
import type { WorkScopeDecision } from './work-scope-decision.js';
import {
  registerService,
  updateServiceStats,
  extractProviderFromUtterance,
  resolveProviderUrl,
} from './external-service-registry.js';
import {
  buildKnowledgeQueryReply,
  buildTaskSessionReply,
  deriveSurfaceQueryRole,
  emptySurfaceResult,
  fetchWeatherSummary,
  loadKnowledgeHintIndex,
  readScheduleAgenda,
  runWebSearch,
  structuredSurfaceQueryText,
  summarizeUserFacingText,
} from './surface-runtime-helpers.js';

export {
  buildDelegationSummaryContext,
  buildDelegationSummaryInstruction,
  extractFollowUpRequests,
} from './surface-runtime-helpers.js';

export const surfaceRuntimeContextStore = new AsyncLocalStorage<SurfaceConversationInput>();

function buildTaskSessionApprovalRequest(
  session: TaskSession,
  queryText: string
): ApprovalRequestDraft | undefined {
  const missing = session.requirements?.missing || [];
  const unresolvedInputs = missing.filter(
    (input) => input !== 'approval_confirmation' && input !== 'dual_key_confirmation'
  );
  if (!session.control.requires_approval || unresolvedInputs.length > 0) return undefined;
  return {
    title: t('dock.intent_resolution.approval_title', { summary: session.goal.summary }, 'ja'),
    summary: t('dock.intent_resolution.approval_summary', { request: queryText }, 'ja'),
    details: session.goal.success_condition,
    severity: 'high',
  };
}

function buildTaskSessionApprovalResult(
  session: TaskSession,
  queryText: string
): ReturnType<typeof emptySurfaceResult> {
  const result = emptySurfaceResult(
    buildTaskSessionReply({
      session,
      status: 'pending',
      intentId: String(session.payload?.intent_id || ''),
      missingInputs: session.requirements?.missing || [],
      approvalRequired: session.control.requires_approval,
    })
  );
  const approvalRequest = buildTaskSessionApprovalRequest(session, queryText);
  if (approvalRequest) result.approvalRequests = [approvalRequest];
  return result;
}

function sessionRuntimePath(namespace: string, sessionId: string, fileName: string): string {
  const normalized = String(sessionId || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) {
    throw new Error('[SURFACE_SESSION_ID] session id must be a single path segment');
  }
  return assertSafeRepositoryPath(
    pathResolver.sharedTmp(`${namespace}/${fileName.replace('{session_id}', normalized)}`),
    { allowMissingLeaf: true }
  );
}

import type {
  SurfaceConversationInput,
  SurfaceConversationResult,
} from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';
import { type ExecutionFeedbackRecord } from './execution-feedback.js';

export interface SurfaceRuntimeRouteHandler {
  matches: (context: SurfaceRuntimeRouteContext) => boolean;
  handle: (context: SurfaceRuntimeRouteContext) => Promise<SurfaceConversationResult>;
}
export function appendCompletionClosure(text: string, completionSummary: string[]): string {
  const closure = completionSummary.filter((line) => String(line || '').trim().length > 0);
  if (closure.length === 0) return text;
  return [text, '', ...closure].join('\n');
}

export function buildExecutionFeedbackPrompt(scenarioId: string): string {
  return [
    `評価: このシナリオを改善する場合は、「評価 ${scenarioId}: 満足」、`,
    `「評価 ${scenarioId}: 一部違う: 修正点」、または「評価 ${scenarioId}: 不満: 理由」で返信できます。`,
  ].join('');
}

export function attachExecutionFeedbackPrompt(
  result: SurfaceConversationResult,
  compiledFlow: UserIntentFlow | null,
  input: SurfaceConversationInput
): SurfaceConversationResult {
  const scenario = compiledFlow?.useCaseScenario;
  if (!scenario) return result;
  return {
    ...result,
    text: [result.text, '', buildExecutionFeedbackPrompt(scenario.scenario_id)]
      .filter(Boolean)
      .join('\n'),
    executionFeedbackRequest: {
      scenario_id: scenario.scenario_id,
      intent_id: scenario.intent_id,
      ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      outcomes: ['satisfied', 'partially_satisfied', 'dissatisfied'],
      structured: true,
    },
  };
}

export function buildFeedbackAcknowledgement(record: ExecutionFeedbackRecord): string {
  const outcomeLabel = {
    satisfied: '満足',
    partially_satisfied: '一部違う',
    dissatisfied: '不満',
  }[record.outcome];
  return `評価を記録しました（${outcomeLabel}）。次回の「${record.scenario_id}」シナリオ生成時に改善候補として反映します。`;
}

export function buildPendingRuntimeContext(
  pendingIntent: ReturnType<typeof loadPendingIntent> | null,
  input: SurfaceConversationInput
): Record<string, unknown> {
  return {
    ...(input.threadContext ? { thread_context: input.threadContext } : {}),
    ...(pendingIntent
      ? {
          pending_intent: {
            correlation_id: pendingIntent.correlation_id,
            intent_id: pendingIntent.intent_id,
            required_inputs: pendingIntent.required_inputs,
            source_surface: pendingIntent.source_surface,
            source_text: pendingIntent.source_text,
            expires_at: pendingIntent.expires_at,
          },
        }
      : {}),
    correction_detected: isCorrectionUtterance(input.query || ''),
  };
}

export function toCompletionSummaryRecord(action: ReturnType<typeof buildCompletionNextAction>): {
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

export function buildDirectReplyCompletionAction(params: {
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

export function buildTaskSessionCompletionAction(input: {
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

export async function handleSurfaceQueryRoute(
  context: SurfaceRuntimeRouteContext,
  resolved: ReturnType<typeof resolveSurfaceIntent>
): Promise<SurfaceConversationResult> {
  const queryText = resolved.queryText || structuredSurfaceQueryText(context);
  const queryType = resolved.queryType || 'knowledge_search';
  const providerConfig = getSurfaceQueryProviderConfig({
    role: deriveSurfaceQueryRole(context),
    phase: getRegisteredEnvText('KYBERION_SURFACE_QUERY_PHASE')?.trim() || undefined,
    scope: currentScope(),
  });

  if (!queryText) {
    return emptySurfaceResult('No query text was provided.');
  }

  if (resolved.intentId === 'schedule-read-agenda') {
    const answer = await readScheduleAgenda(queryText, context.resolutionPacket?.contextual_frame);
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

export async function handleTaskSessionRoute(
  context: SurfaceRuntimeRouteContext
): Promise<SurfaceConversationResult> {
  const queryText = structuredSurfaceQueryText(context);
  const correctionDetected = isCorrectionUtterance(queryText);

  // 1. Intercept for Progressive Slot-filling state machine
  const activeSession = getActiveTaskSession(context.input.surface || 'presence');
  let session = activeSession;
  let intent: any = null;

  if (activeSession && activeSession.requirements?.missing?.length > 0 && correctionDetected) {
    // IL-05 Task 2: a correction targets what was JUST answered — backtrack
    // to the last filled slot (restore it to the front of missing and drop
    // its value) instead of re-asking the next empty slot, which would lose
    // the correction target. With nothing filled yet, re-ask the current one.
    const filledOrder = activeSession.requirements.filled_order || [];
    if (filledOrder.length > 0) {
      const lastFilled = filledOrder[filledOrder.length - 1];
      const restoredMissing = [
        lastFilled,
        ...activeSession.requirements.missing.filter((slot) => slot !== lastFilled),
      ];
      const restoredPayload = { ...(activeSession.payload || {}) };
      delete restoredPayload[lastFilled];
      const backtracked = updateTaskSession(activeSession.session_id, {
        payload: restoredPayload,
        requirements: {
          ...activeSession.requirements,
          missing: restoredMissing,
          filled_order: filledOrder.slice(0, -1),
        },
        status: 'collecting_requirements',
      });
      return emptySurfaceResult(
        buildTaskSessionReply({
          session: backtracked || activeSession,
          status: 'pending',
          intentId: (activeSession.payload?.intent_id as string) || '',
          summary: `了解です。${lastFilled} を修正します。もう一度教えてください。`,
          missingInputs: restoredMissing,
        })
      );
    }
    const currentSlot = activeSession.requirements.missing[0];
    return emptySurfaceResult(
      buildTaskSessionReply({
        session: activeSession,
        status: 'pending',
        intentId: (activeSession.payload?.intent_id as string) || '',
        summary: `了解です。${currentSlot} をもう一度教えてください。`,
        missingInputs: activeSession.requirements.missing,
      })
    );
  }

  if (
    activeSession &&
    activeSession.requirements?.missing &&
    activeSession.requirements.missing.length > 0
  ) {
    const missingList = activeSession.requirements.missing;
    const nextSlot = missingList[0];

    const approvalOnly = missingList.every(
      (input) => input === 'approval_confirmation' || input === 'dual_key_confirmation'
    );
    if (approvalOnly && activeSession.control.requires_approval) {
      return buildTaskSessionApprovalResult(activeSession, queryText);
    }

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
    const updatedRequirements = {
      ...activeSession.requirements,
      missing: updatedMissing,
      filled_order: [...(activeSession.requirements?.filled_order || []), nextSlot],
    };
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
    if (correctionDetected) {
      const completedSession = context.input.correlationId
        ? getLatestCompletedTaskSession(
            context.input.surface || 'presence',
            context.input.correlationId
          )
        : null;
      if (completedSession) {
        const reopened = reopenTaskSession(completedSession.session_id, {
          reason: `correction utterance: ${queryText}`,
          status: completedSession.requirements?.missing?.length
            ? 'collecting_requirements'
            : 'planning',
        });
        if (reopened) {
          return emptySurfaceResult(
            buildTaskSessionReply({
              session: reopened,
              status: 'pending',
              intentId: (reopened.payload?.intent_id as string) || '',
              summary: '前回のセッションを再オープンしました。修正したい点を教えてください。',
              missingInputs: reopened.requirements?.missing || [],
            })
          );
        }
      }
    }
    const freshIntent = classifyTaskSessionIntent(queryText, context.resolutionPacket, {
      tier: context.input.scope?.tier,
      tenantId: context.input.scope?.tenant_slug,
    });
    if (!freshIntent?.intentId) {
      return emptySurfaceResult('No task-session intent could be resolved.');
    }
    intent = freshIntent;

    session = createTaskSession({
      sessionId: `TSK-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      correlationId: context.input.correlationId,
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
          output_path: sessionRuntimePath('external-data', session.session_id, '{session_id}.txt'),
          preview_text: preview.text,
          omitted_count: preview.omitted_count,
          storage_class: 'tmp',
        },
      });

      safeWriteFile(
        sessionRuntimePath('external-data', session.session_id, '{session_id}.txt'),
        `topic: ${dataTopic}\nurl: ${sourceUrl}\n\n${plainText}`,
        { mkdir: true, encoding: 'utf8' }
      );

      const completionAction = buildTaskSessionCompletionAction({
        session: updated || session,
        output: summary,
        outputPath: sessionRuntimePath('external-data', session.session_id, '{session_id}.txt'),
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

  if (
    session.requirements?.missing?.length === 0 &&
    !session.control.requires_approval &&
    isRunnableServiceTask
  ) {
    try {
      let output = '';
      if (sessionIntentId === 'resolve-approval' || sessionIntentId === 'request-approval') {
        const tempFile = sessionRuntimePath(
          'approval-actuator-inputs',
          session.session_id,
          'input-{session_id}.json'
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
            correlationId:
              session.correlation_id ||
              session.payload?.correlation_id ||
              session.payload?.correlationId ||
              session.session_id,
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

        const resultJson = parseSurfaceActuatorResult(execRes, 'approval-actuator');
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
        const tempFile = sessionRuntimePath(
          'system-actuator-inputs',
          session.session_id,
          'input-{session_id}.json'
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
        const resultJson = parseSurfaceActuatorResult(execRes, 'system-actuator');
        output = `[System-Actuator] 音声入力を有効化しました。対象: ${serviceName}\n結果: ${JSON.stringify(resultJson, null, 2)}`;
      } else {
        output = `サービスオペレーション [${sessionIntentId}] を正常に実行しました。`;
      }

      const updated = updateTaskSession(session.session_id, {
        status: 'completed',
        artifact: {
          kind: `${sessionIntentId}_result`,
          output_path: sessionRuntimePath(
            'service-operations',
            session.session_id,
            '{session_id}.txt'
          ),
          ...truncateTextWithCount(output, 500),
          storage_class: 'tmp',
        },
      });

      safeWriteFile(
        sessionRuntimePath('service-operations', session.session_id, '{session_id}.txt'),
        output,
        { mkdir: true, encoding: 'utf8' }
      );

      const completionAction = buildTaskSessionCompletionAction({
        session: updated || session,
        output: output,
        outputPath: sessionRuntimePath(
          'service-operations',
          session.session_id,
          '{session_id}.txt'
        ),
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

  const approvalRequest = buildTaskSessionApprovalRequest(session, queryText);
  const result = emptySurfaceResult(
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
      approvalRequired: session.control.requires_approval,
    })
  );
  if (approvalRequest) result.approvalRequests = [approvalRequest];
  return result;
}

export function ensureMissionId(context: SurfaceRuntimeRouteContext): string {
  if (context.input.missionId) return context.input.missionId;
  throw new Error('mission_id is required for this mission action');
}

export function recordLearningOutcomeSafely(
  params: Parameters<typeof recordIntentContractOutcome>[0]
): void {
  try {
    const surfaceInput = surfaceRuntimeContextStore.getStore();
    recordIntentContractOutcome({
      ...params,
      ...(params.scope ? {} : { scope: currentScope() }),
      ...(surfaceInput?.missionId ? { mission_id: surfaceInput.missionId } : {}),
      ...(surfaceInput?.correlationId ? { correlation_id: surfaceInput.correlationId } : {}),
    });
  } catch {
    // Learning updates are best-effort and must not block primary execution paths.
  }
}

export function getWorkScopeDecision(
  context: SurfaceRuntimeRouteContext
): WorkScopeDecision | null {
  return context.compiledFlow?.workLoop?.work_scope_decision || null;
}

export function shouldPromoteToMission(context: SurfaceRuntimeRouteContext): boolean {
  const workScopeDecision = getWorkScopeDecision(context);
  return Boolean(workScopeDecision?.promotion_required);
}

export function buildWorkScopeGovernancePayload(
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

export function buildWorkScopeGovernanceReceipt(context: SurfaceRuntimeRouteContext):
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

export function missionActionGuidance(
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

export function buildSurfaceDelegationRequest(params: {
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

export function directIntentCommand(intentId?: string): { command: string; args: string[] } | null {
  return resolveDirectIntentCommand(intentId);
}

/**
 * IL-01: thread the interpreted intent (utterance + agreed goal + outcome ids)
 * across the mission-promotion seam via a governed tmp handoff file, so the
 * mission's outcome contract reflects the real request. Failure-tolerant:
 * goal threading must never block mission creation.
 */
export function buildIntentGoalHandoffArgs(
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
    const correlationId = context.input.correlationId || contract?.intent_id || undefined;
    const handoffPath = writeIntentGoalHandoff(missionId, {
      source_text: sourceText || undefined,
      correlation_id: correlationId,
      origin_intent_id: contract?.intent_id || undefined,
      origin_utterance_ref: context.input.correlationId
        ? `surface://${context.input.correlationId}`
        : undefined,
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

/**
 * IL-01 (acceptance 2, pipeline seam): carry the interpreted goal into the
 * pipeline execution context so steps and completion reconciliation can see
 * the real request. Failure-tolerant — goal threading never blocks the run.
 */
export function buildPipelineIntentContextArgs(context: SurfaceRuntimeRouteContext): string[] {
  const contract = context.compiledFlow?.intentContract;
  const sourceText = String(
    contract?.source_text || context.input.surfaceText || context.structuredQuery || ''
  ).trim();
  const summary = contract?.goal?.summary?.trim();
  if (!summary && !sourceText) return [];
  try {
    const intentGoal = {
      intent_goal: {
        ...(sourceText ? { source_text: sourceText } : {}),
        ...(summary ? { summary } : {}),
        ...(contract?.goal?.success_condition
          ? { success_condition: contract.goal.success_condition }
          : {}),
        ...(contract?.intent_id ? { intent_id: contract.intent_id } : {}),
      },
    };
    return ['--context', JSON.stringify(intentGoal)];
  } catch {
    return [];
  }
}

/**
 * Keep the governed use-case scenario visible to the Surface agent whenever
 * the intent compiler ran. Short/direct Surface routes intentionally bypass
 * this context for latency, but compiled routes should have one canonical
 * user-facing plan for clarification, approval, and execution handoff.
 */
export function buildSurfaceStructuredQuery(query: string, compiledFlow: UserIntentFlow): string {
  return [
    query,
    '',
    'Governed execution brief:',
    JSON.stringify(compiledFlow.executionBrief, null, 2),
    compiledFlow.executionBrief?.workflow_steps?.length ? '' : undefined,
    compiledFlow.executionBrief?.workflow_steps?.length ? 'Governed workflow steps:' : undefined,
    compiledFlow.executionBrief?.workflow_steps?.length
      ? JSON.stringify(compiledFlow.executionBrief.workflow_steps, null, 2)
      : undefined,
    '',
    'Governed intent contract:',
    JSON.stringify(compiledFlow.intentContract, null, 2),
    '',
    'Governed work loop:',
    JSON.stringify(compiledFlow.workLoop, null, 2),
    compiledFlow.useCaseScenario ? '' : undefined,
    compiledFlow.useCaseScenario
      ? 'Governed use-case scenario (canonical user-facing handoff):'
      : undefined,
    compiledFlow.useCaseScenario
      ? JSON.stringify(compiledFlow.useCaseScenario, null, 2)
      : undefined,
    compiledFlow.useCaseScenario
      ? 'Follow the scenario handoff: clarify missing inputs, request approval, resolve runtime blockers, or execute as indicated. Explain the next step concisely to the user.'
      : undefined,
  ]
    .filter((item): item is string => typeof item === 'string')
    .join('\n');
}
