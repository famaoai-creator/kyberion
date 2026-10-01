import { extractSurfaceBlocks, sanitizeSurfaceReplyText } from './surface-response-blocks.js';
import { t } from '../t.js';
import { detectTextLocale } from '../locale-normalize.js';
import { resolveLocale } from '../locale.js';
import type {
  SurfaceConversationResult,
  SurfaceDelegationResult,
} from './channel-surface-types.js';
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

  return segments
    .filter((segment) => requestPatterns.some((pattern) => pattern.test(segment)))
    .slice(0, 3);
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
      (request) => `${result.receiver || 'unknown'}: ${request}`
    )
  );
  const lines = [
    `Original request: ${summarizeUserFacingText(params.originalQuery, 600) || '(empty)'}`,
    '',
    'Delegated results:',
    ...params.delegationResults
      .filter((result) => !result.error)
      .map((result) => {
        const response =
          summarizeUserFacingText(String(result.response || ''), 800) || '(no response)';
        return `- ${result.receiver || 'unknown'}: ${response}`;
      }),
  ];
  if (followUpRequests.length > 0) {
    lines.push(
      '',
      'Follow-up requests from delegated work:',
      ...followUpRequests.map((request) => `- ${request}`)
    );
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
  completionSummary?: string[];
  approvalRequired?: boolean;
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
    lines.push(t('surface:task_reply_completed'));
  } else if (params.status === 'pending') {
    lines.push(t('surface:task_reply_pending'));
  } else {
    lines.push(t('surface:task_reply_failed'));
  }

  if (params.status === 'completed') {
    lines.push(
      isScheduleCoordination
        ? t('surface:task_reply_schedule_check_done')
        : t('surface:task_reply_check_done')
    );
  } else if (params.status === 'pending') {
    lines.push(
      isScheduleCoordination
        ? t('surface:task_reply_schedule_check_pending')
        : t('surface:task_reply_check_pending')
    );
  } else {
    lines.push(
      isScheduleCoordination
        ? t('surface:task_reply_schedule_check_failed')
        : t('surface:task_reply_check_failed')
    );
  }

  if (params.summary) {
    lines.push(params.summary);
  }

  if (params.missingInputs && params.missingInputs.length > 0) {
    const readableMissing = params.missingInputs
      .map((input) => {
        const map: Record<string, string> = {
          schedule_scope: t('surface:task_reply_slot_schedule_scope'),
          date_range: t('surface:task_reply_slot_date_range'),
          fixed_constraints: t('surface:task_reply_slot_fixed_constraints'),
          calendar_action_boundary: t('surface:task_reply_slot_calendar_action_boundary'),
          meeting_handoff_boundary: t('surface:task_reply_slot_meeting_handoff_boundary'),
        };
        return map[input] || input.replace(/_/g, ' ');
      })
      .join(t('surface:task_reply_list_separator'));
    lines.push(
      isScheduleCoordination
        ? t('surface:task_reply_schedule_missing', { items: readableMissing })
        : t('surface:task_reply_missing', { items: readableMissing })
    );
  }

  const unresolvedInputs = (params.missingInputs || []).filter(
    (input) => input !== 'approval_confirmation' && input !== 'dual_key_confirmation'
  );
  if (params.approvalRequired && unresolvedInputs.length === 0) {
    lines.push(t('dock.intent_resolution.waiting_approval'));
    lines.push(t('dock.intent_resolution.approval_action'));
  }

  const serviceOptions = params.serviceOptions || [];
  if (params.intentId === 'stop-service' && serviceOptions.length > 0) {
    lines.push(t('surface:task_reply_stop_candidates'));
    serviceOptions.forEach((choice, index) => {
      const serviceName =
        typeof choice === 'string'
          ? choice
          : choice.service_name || choice.surface_id || choice.service_id || 'unknown';
      const serviceId =
        typeof choice === 'string'
          ? undefined
          : choice.service_id && choice.service_id !== serviceName
            ? choice.service_id
            : undefined;
      const description = typeof choice === 'string' ? undefined : choice.description;
      lines.push(
        `  ${index + 1}. ${serviceName}${serviceId ? ` (service: ${serviceId})` : ''}${description ? ` - ${description}` : ''}`
      );
    });
    lines.push(t('surface:task_reply_stop_prompt'));
  }

  if (params.intentId === 'start-service' && serviceOptions.length > 0) {
    lines.push(t('surface:task_reply_start_candidates'));
    serviceOptions.forEach((choice, index) => {
      const serviceName =
        typeof choice === 'string'
          ? choice
          : choice.service_name || choice.surface_id || choice.service_id || 'unknown';
      const serviceId =
        typeof choice === 'string'
          ? undefined
          : choice.service_id && choice.service_id !== serviceName
            ? choice.service_id
            : undefined;
      const description = typeof choice === 'string' ? undefined : choice.description;
      lines.push(
        `  ${index + 1}. ${serviceName}${serviceId ? ` (service: ${serviceId})` : ''}${description ? ` - ${description}` : ''}`
      );
    });
    lines.push(t('surface:task_reply_start_prompt'));
  }

  if (params.handoffIntentId) {
    lines.push(
      params.handoffIntentId === 'meeting-operations'
        ? t('surface:task_reply_handoff_meeting')
        : t('surface:task_reply_handoff_next')
    );
  }

  if (params.completionSummary && params.completionSummary.length > 0) {
    lines.push(...params.completionSummary);
  }

  if (params.error) {
    lines.push(t('surface:task_reply_detail', { error: params.error }));
  }

  return lines.filter(Boolean).join('\n');
}

function buildKnowledgeQueryReply(params: {
  queryText: string;
  results: Array<{ topic: string; hint: string; source?: string; tags?: string[] }>;
  providerLabel: string;
}): string {
  // The reply follows the language the user asked in.
  const locale = detectTextLocale(params.queryText) ?? resolveLocale();
  if (params.results.length === 0) {
    return t('surface:knowledge_reply_none', undefined, locale);
  }

  const opener = t(
    'surface:knowledge_reply_opener',
    { provider: params.providerLabel, count: params.results.length },
    locale
  );
  const bullets = params.results.slice(0, 3).map((result) => {
    const tags = result.tags?.length
      ? t(
          'surface:knowledge_reply_tags',
          { tags: result.tags.join(t('surface:task_reply_list_separator', undefined, locale)) },
          locale
        )
      : '';
    const source = result.source ? ` / ${result.source}` : '';
    return `- ${result.topic}${tags}${source}: ${result.hint}`;
  });

  const closing = t('surface:knowledge_reply_closing', undefined, locale);
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
