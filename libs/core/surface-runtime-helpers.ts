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

function getScheduleDateRange(
  value?: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'this_month' | 'next_month' | 'custom'
): { start: Date; end: Date; label: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const weekday = start.getDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const thisWeekStart = new Date(start.getTime() + mondayOffset * dayMs);
  const nextWeekStart = new Date(thisWeekStart.getTime() + 7 * dayMs);

  switch (value) {
    case 'today':
      return { start, end: new Date(start.getTime() + dayMs - 1), label: 'today' };
    case 'tomorrow': {
      const tomorrow = new Date(start.getTime() + dayMs);
      return { start: tomorrow, end: new Date(tomorrow.getTime() + dayMs - 1), label: 'tomorrow' };
    }
    case 'this_week':
      return { start: thisWeekStart, end: new Date(thisWeekStart.getTime() + 7 * dayMs - 1), label: 'this_week' };
    case 'next_week':
      return { start: nextWeekStart, end: new Date(nextWeekStart.getTime() + 7 * dayMs - 1), label: 'next_week' };
    case 'this_month': {
      const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);
      const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      return { start: monthStart, end: monthEnd, label: 'this_month' };
    }
    case 'next_month': {
      const monthStart = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      const monthEnd = new Date(start.getFullYear(), start.getMonth() + 2, 0, 23, 59, 59, 999);
      return { start: monthStart, end: monthEnd, label: 'next_month' };
    }
    default:
      return { start, end: new Date(start.getTime() + 7 * dayMs - 1), label: 'next_week' };
  }
}

function formatCalendarAgendaReply(params: {
  sourceLabel: string;
  sourceName?: string;
  rangeLabel: string;
  events: Array<{ title: string; start: string; end: string; calendar?: string }>;
  assumption?: string;
}): string {
  const header = params.sourceName ? `${params.sourceLabel} / ${params.sourceName}` : params.sourceLabel;
  if (params.events.length === 0) {
    return [
      params.assumption ? `${params.assumption}` : '',
      `Provider: ${header}`,
      `${params.rangeLabel} の予定は見つかりませんでした。`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines = [
    ...(params.assumption ? [params.assumption] : []),
    `Provider: ${header}`,
    `${params.rangeLabel} の予定:`,
    ...params.events.slice(0, 10).map((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      const time = `${start.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
      const calendar = event.calendar ? ` (${event.calendar})` : '';
      return `- ${time} ${event.title}${calendar}`;
    }),
  ];
  return lines.join('\n');
}

async function readScheduleAgenda(queryText: string): Promise<string> {
  const frame = buildContextualIntentFrame(queryText);
  const clarificationDecision = assessContextualClarification({
    intentId: 'schedule-read-agenda',
    text: queryText,
    executionShape: 'direct_reply',
    requiredInputs:
      frame.missing.length > 0
        ? frame.missing
        : frame.date_range
          ? []
          : ['date_range'],
    confidence: frame.confidence,
    contextualFrame: frame,
  });
  const scheduleSource = frame.source_binding.selected || resolveDefaultScheduleSource().source || 'browser_calendar';
  const calendarName = resolveDefaultScheduleSource().calendarName;
  const range = getScheduleDateRange(frame.date_range?.value);
  const assumption = [
    frame.subject === 'operator_self' ? '本人の既定カレンダーとして確認します。' : '',
    frame.date_range ? '' : `期間は ${range.label} として補完します。`,
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const calendarPath = '../actuators/calendar-actuator/src/index.js';
    const calendarActuator: any = await import(calendarPath);
    const events = await calendarActuator.listEvents({
      ...(calendarName ? { calendar_names: [calendarName] } : {}),
      start_date: range.start.toISOString(),
      end_date: range.end.toISOString(),
    });
    recordContextualIntentLearning({
      utterance: queryText,
      intentId: 'schedule-read-agenda',
      frame,
      clarificationNeeded: clarificationDecision.shouldClarify,
      confirmed: true,
      tier: 'personal',
      responseShape: 'calendar_agenda_summary',
      notes: `read-only agenda returned ${Array.isArray(events) ? events.length : 0} event(s)`,
    });
    if (frame.source_binding.selected) {
      recordSchedulePreference({
        source: frame.source_binding.selected,
        calendarName,
        utterance: queryText,
        confirmed: true,
      });
    }
    return formatCalendarAgendaReply({
      sourceLabel: scheduleSource,
      sourceName: calendarName,
      rangeLabel: range.label,
      events: Array.isArray(events) ? events : [],
      assumption,
    });
  } catch (error: any) {
    recordContextualIntentLearning({
      utterance: queryText,
      intentId: 'schedule-read-agenda',
      frame,
      clarificationNeeded: clarificationDecision.shouldClarify,
      confirmed: false,
      tier: 'personal',
      responseShape: 'calendar_agenda_summary',
      notes: `calendar-actuator read failed: ${error?.message || String(error)}`,
    });
    if (frame.source_binding.selected) {
      recordSchedulePreference({
        source: frame.source_binding.selected,
        calendarName,
        utterance: queryText,
        confirmed: false,
      });
    }
    return `Provider: ${scheduleSource}${calendarName ? ` / ${calendarName}` : ''}\n${range.label} の予定を取得しようとしましたが、calendar-actuator で読めませんでした: ${error?.message || String(error)}`;
  }
}

function buildDelegatedSurfaceConversationResult(
  delegationResults: SurfaceDelegationResult[]
): SurfaceConversationResult {
  const successful = delegationResults.filter((result) => !result.error);
  const firstResponse = successful[0]?.response || '';
  const parsed = extractSurfaceBlocks(firstResponse);
  return {
    text: parsed.text,
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
  const baseText = context.input.surfaceText || context.input.query || context.structuredQuery || '';
  const contextualText = context.input.threadContext
    ? `${context.input.threadContext}\n\nCurrent incoming message:\n${baseText}`
    : baseText;
  return contextualText.trim();
}

function resolvedSurfaceIntent(context: SurfaceRuntimeRouteContext): ReturnType<typeof resolveSurfaceIntent> {
  return context.resolvedIntent || resolveSurfaceIntent(structuredSurfaceQueryText(context));
}

function deriveSurfaceQueryRole(context: SurfaceRuntimeRouteContext): string | undefined {
  const surface = context.input.surface;
  if (!surface) return undefined;
  return `${surface.replace(/-/g, '_')}_surface_agent`;
}

let knowledgeIndexPromise: Promise<KnowledgeHintIndex> | null = null;
let _lastScope: KnowledgeScope | null = null;

async function loadKnowledgeHintIndex(scope: KnowledgeScope = DEFAULT_SCOPE): Promise<KnowledgeHintIndex> {
  const scopeKey = JSON.stringify(scope);
  if (!knowledgeIndexPromise || JSON.stringify(_lastScope) !== scopeKey) {
    _lastScope = scope;
    knowledgeIndexPromise = buildScopedIndex(scope);
  }
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

async function fetchWeatherSummary(queryText: string): Promise<string> {
  const locationHint = extractLocationHint(queryText);
  let latitude: number | undefined;
  let longitude: number | undefined;
  let label = locationHint || '';
  const providerConfig = getSurfaceQueryProviderConfig();
  const weatherConfig = providerConfig.weather || {};
  const geocodingUrl = weatherConfig.geocodingUrl;
  const forecastUrl = weatherConfig.forecastUrl;

  if (locationHint) {
    if (!geocodingUrl) {
      throw new Error('weather geocoding endpoint is not configured');
    }
    const geocode = await secureFetch<any>({
      method: 'GET',
      url: geocodingUrl,
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
    const currentLocation = await resolveFallbackLocationSummary();
    label = currentLocation;
  }

  if (!forecastUrl) {
    throw new Error('weather forecast endpoint is not configured');
  }

  const weather = await secureFetch<any>({
    method: 'GET',
    url: forecastUrl,
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
