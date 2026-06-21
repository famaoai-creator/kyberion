import { randomUUID } from 'node:crypto';

import { buildScopedIndex, queryKnowledgeHybrid, DEFAULT_SCOPE, type KnowledgeHintIndex, type KnowledgeScope } from './src/knowledge-index.js';
import { secureFetch } from './network.js';
import { safeExec } from './secure-io.js';
import { resolveFallbackLocationSummary } from './location-fallback.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { recordSchedulePreference, resolveDefaultScheduleSource } from './contextual-intent-memory.js';
import { recordContextualIntentLearning } from './contextual-intent-learning.js';
import type { UserIntentFlow } from './intent-contract.js';
import type { ContractCandidate } from './intent-contract-learning.js';
import { extractSurfaceBlocks, sanitizeSurfaceReplyText } from './surface-response-blocks.js';
import type { SurfaceRuntimeRouteContext } from './surface-runtime-router.js';
import type { SurfaceConversationResult, SurfaceDelegationResult } from './channel-surface-types.js';
import { resolveSurfaceIntent } from './router-contract.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
import {
  attachRoutingDecision,
  buildDelegatedSurfaceConversationResult,
  extractLocationHint,
  fetchWeatherSummary,
  formatCalendarAgendaReply,
  formatExecutionReceipt,
  getScheduleDateRange,
  loadKnowledgeHintIndex,
  readScheduleAgenda,
  resolvedSurfaceIntent,
  runWebSearch,
  structuredSurfaceQueryText,
  deriveSurfaceQueryRole,
} from './surface-query-helpers.js';

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

function summarizeUserFacingText(input: string, maxLength = 260): string {
  const sanitized = extractSurfaceBlocks(input).text || sanitizeSurfaceReplyText(input);
  const normalized = sanitized.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function extractFollowUpRequests(input: string): string[] {
  const normalized = summarizeUserFacingText(input, 1200);
  if (!normalized) return [];

  const segments = normalized
    .split(/(?<=[。！？?!])\s+|\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const requestPatterns = [
    /\b(could you|can you|would you|please|do you know|do you have)\b/i,
    /\b(need|needs|missing|confirm|clarif(?:y|ication)|follow[- ]?up)\b/i,
    /(教えて|確認して|確認してください|必要です|ください|できますか|でしょうか)/u,
    /[？?]$/u,
  ];

  return segments.filter((segment) => requestPatterns.some((pattern) => pattern.test(segment))).slice(0, 3);
}

export function buildDelegationSummaryInstruction(): string {
  return [
    'You are the final user-facing reply writer.',
    'Convert the delegated results into a concise answer for the human user.',
    'Do not mention internal routing, A2A, task sessions, receipts, IDs, or reasoning.',
    'Use plain language.',
    'If a delegated result includes a question or missing detail request, surface it as a direct follow-up question to the human user instead of hiding it.',
    'If the answer is incomplete, say what is done and what is next.',
    'Prefer one short paragraph or up to three bullets.',
  ].join(' ');
}

export function buildDelegationSummaryContext(params: {
  originalQuery: string;
  delegationResults: SurfaceDelegationResult[];
}): string {
  const followUpRequests = params.delegationResults.flatMap((result) =>
    extractFollowUpRequests(String(result.response || '')).map(
      (request) => `${result.receiver || 'unknown'}: ${request}`,
    ),
  );
  const lines = [
    `Original request: ${summarizeUserFacingText(params.originalQuery, 600) || '(empty)'}`,
    '',
    'Delegated results:',
    ...params.delegationResults
      .filter((result) => !result.error)
      .map((result) => {
        const response = summarizeUserFacingText(String(result.response || ''), 800) || '(no response)';
        return `- ${result.receiver || 'unknown'}: ${response}`;
      }),
  ];
  if (followUpRequests.length > 0) {
    lines.push('', 'Follow-up requests from delegated work:', ...followUpRequests.map((request) => `- ${request}`));
  }
  return lines.join('\n');
}

function buildTaskSessionReply(params: {
  session: { session_id: string };
  status: 'completed' | 'failed' | 'pending';
  summary?: string;
  outputPath?: string;
  error?: string;
  intentId?: string;
  missingInputs?: string[];
  handoffIntentId?: string;
  kind?: string;
  serviceOptions?: Array<
    | string
    | {
        service_name?: string;
        service_id?: string;
        surface_id?: string;
        description?: string;
        kind?: string;
        startup_mode?: string;
      }
  >;
}): string {
  const lines: string[] = [];
  const isScheduleCoordination = params.intentId === 'schedule-coordination';

  if (params.status === 'completed') {
    lines.push('短い作業として完了しました。');
  } else if (params.status === 'pending') {
    lines.push('短い作業として進めます。');
  } else {
    lines.push('短い作業としてうまく進められませんでした。');
  }

  if (params.status === 'completed') {
    lines.push(isScheduleCoordination ? '予定の確認が終わりました。' : '確認が終わりました。');
  } else if (params.status === 'pending') {
    lines.push(isScheduleCoordination ? '予定の確認を進めます。' : '確認を進めます。');
  } else {
    lines.push(isScheduleCoordination ? '予定の確認がうまく進みませんでした。' : 'うまく進められませんでした。');
  }

  if (params.summary) {
    lines.push(params.summary);
  }

  if (params.missingInputs && params.missingInputs.length > 0) {
    const readableMissing = params.missingInputs
      .map((input) => {
        const map: Record<string, string> = {
          schedule_scope: '対象',
          date_range: '期間',
          fixed_constraints: '動かせない条件',
          calendar_action_boundary: '提案だけか更新まで行うか',
          meeting_handoff_boundary: '会議調整への引き継ぎ可否',
        };
        return map[input] || input.replace(/_/g, ' ');
      })
      .join('、');
    lines.push(isScheduleCoordination ? `確認したい点があります: ${readableMissing}` : `必要な情報があります: ${readableMissing}`);
  }

  const serviceOptions = params.serviceOptions || [];
  if (params.intentId === 'stop-service' && serviceOptions.length > 0) {
    lines.push('停止するサービス候補:');
    serviceOptions.forEach((choice, index) => {
      const serviceName = typeof choice === 'string'
        ? choice
        : choice.service_name || choice.surface_id || choice.service_id || 'unknown';
      const serviceId = typeof choice === 'string'
        ? undefined
        : choice.service_id && choice.service_id !== serviceName
          ? choice.service_id
          : undefined;
      const description = typeof choice === 'string'
        ? undefined
        : choice.description;
      lines.push(`  ${index + 1}. ${serviceName}${serviceId ? ` (service: ${serviceId})` : ''}${description ? ` - ${description}` : ''}`);
    });
    lines.push('停止したいサービス名を指定してください。');
  }

  if (params.intentId === 'start-service' && serviceOptions.length > 0) {
    lines.push('起動するサービス候補:');
    serviceOptions.forEach((choice, index) => {
      const serviceName = typeof choice === 'string'
        ? choice
        : choice.service_name || choice.surface_id || choice.service_id || 'unknown';
      const serviceId = typeof choice === 'string'
        ? undefined
        : choice.service_id && choice.service_id !== serviceName
          ? choice.service_id
          : undefined;
      const description = typeof choice === 'string'
        ? undefined
        : choice.description;
      lines.push(`  ${index + 1}. ${serviceName}${serviceId ? ` (service: ${serviceId})` : ''}${description ? ` - ${description}` : ''}`);
    });
    lines.push('起動したいサービス名を指定してください。');
  }

  if (params.handoffIntentId) {
    lines.push(
      params.handoffIntentId === 'meeting-operations'
        ? '必要なら会議調整まで引き継げます。'
        : '必要なら次の担当に引き継げます。'
    );
  }

  if (params.error) {
    lines.push(`詳細: ${params.error}`);
  }

  return lines.filter(Boolean).join('\n');
}

function buildKnowledgeQueryReply(params: {
  queryText: string;
  results: Array<{ topic: string; hint: string; source?: string; tags?: string[] }>;
  providerLabel: string;
}): string {
  const isJapanese = /[ぁ-んァ-ン一-龯]/.test(params.queryText);
  if (params.results.length === 0) {
    return isJapanese
      ? `見つかった情報はありませんでした。必要なら別の言い方で探し直せます。`
      : `I couldn't find a match. If you want, I can try a different phrasing.`;
  }

  const opener = isJapanese
    ? `確認できた内容を短くまとめると、${params.providerLabel} で ${params.results.length} 件見つかりました。`
    : `Here is the short summary from ${params.providerLabel}: I found ${params.results.length} item(s).`;
  const bullets = params.results.slice(0, 3).map((result) => {
    const tags = result.tags?.length ? `（${result.tags.join('、')}）` : '';
    const source = result.source ? ` / ${result.source}` : '';
    return isJapanese
      ? `- ${result.topic}${tags}${source}: ${result.hint}`
      : `- ${result.topic}${tags}${source}: ${result.hint}`;
  });

  const closing = isJapanese
    ? '必要なら、ここからさらに絞って見ます。'
    : "If you'd like, I can narrow this down further.";
  return [opener, ...bullets, closing].join('\n');
}

export {
  attachRoutingDecision,
  buildDelegatedSurfaceConversationResult,
  buildKnowledgeQueryReply,
  buildTaskSessionReply,
  emptySurfaceResult,
  extractLocationHint,
  fetchWeatherSummary,
  formatCalendarAgendaReply,
  formatExecutionReceipt,
  getScheduleDateRange,
  loadKnowledgeHintIndex,
  readScheduleAgenda,
  resolvedSurfaceIntent,
  runWebSearch,
  structuredSurfaceQueryText,
  summarizeUserFacingText,
  deriveSurfaceQueryRole,
};
