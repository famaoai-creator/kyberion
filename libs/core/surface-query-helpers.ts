import { buildScopedIndex, queryKnowledgeHybrid, DEFAULT_SCOPE, type KnowledgeHintIndex, type KnowledgeScope } from './src/knowledge-index.js';
import { secureFetch } from './network.js';
import { resolveFallbackLocationSummary } from './location-fallback.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';
import { assessContextualClarification } from './contextual-intent-clarification-policy.js';
import { recordSchedulePreference, resolveDefaultScheduleSource } from './contextual-intent-memory.js';
import { recordContextualIntentLearning } from './contextual-intent-learning.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import { resolveSurfaceIntent } from './router-contract.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
import { safeExec } from './secure-io.js';
import type { SurfaceConversationResult, SurfaceDelegationResult } from './channel-surface-types.js';
import type { UserIntentFlow } from './intent-contract.js';

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

function parseCalendarDate(value: string | undefined, label: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`calendar query: invalid ${label}: "${value}"`);
  }
  return date;
}

async function listCalendarEvents(params: {
  calendar_names?: string[];
  start_date: string;
  end_date: string;
}): Promise<Array<{ title: string; start: string; end: string; calendar: string; location: string; description: string }>> {
  const startInput = parseCalendarDate(params.start_date, 'start_date');
  const endInput = parseCalendarDate(params.end_date, 'end_date');
  const start = startInput ?? new Date();
  if (!startInput) start.setHours(0, 0, 0, 0);
  const end = endInput ?? new Date(start.getTime() + 24 * 60 * 60 * 1000);
  if (!endInput) end.setHours(23, 59, 59, 999);
  if (end.getTime() <= start.getTime()) {
    throw new Error(`calendar query: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`);
  }

  const payload = {
    calendar_names: params.calendar_names ?? [],
    start_iso: start.toISOString(),
    end_iso: end.toISOString(),
  };
  const script = `
    (function() {
      const PARAMS = JSON.parse(${JSON.stringify(JSON.stringify(payload))});
      const app = Application("Calendar");
      const targets = PARAMS.calendar_names && PARAMS.calendar_names.length ? PARAMS.calendar_names : null;
      const startLimit = new Date(PARAMS.start_iso);
      const endLimit = new Date(PARAMS.end_iso);
      const results = [];
      app.calendars().forEach(function (cal) {
        if (targets && targets.indexOf(cal.name()) === -1) return;
        try {
          const events = cal.events.which({
            _and: [
              { startDate: { ">=": startLimit } },
              { startDate: { "<": endLimit } }
            ]
          });
          events().forEach(function (ev) {
            results.push({
              title: ev.summary(),
              start: ev.startDate().toISOString(),
              end: ev.endDate().toISOString(),
              calendar: cal.name(),
              location: ev.location() || "",
              description: ev.description() || ""
            });
          });
        } catch (e) {
          // Silently skip calendars that fail to query (permission / corrupted state).
        }
      });
      return JSON.stringify(results);
    })();
  `;
  const output = await safeExec('osascript', ['-l', 'JavaScript', '-e', script]);
  const trimmed = String(output).trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
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
    const events = await listCalendarEvents({
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
  const parsed = extractSurfaceBlocks(String(firstResponse || ''));
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
  candidateSelection?: Array<{ contract_ref: unknown; score: number; source: string }>;
  governance?: {
    policy_version?: string;
    promotion_required?: boolean;
    matched_rule_ids?: string[];
    mandatory_triggers?: string[];
    accumulation_triggers?: string[];
  };
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
      governance: params.governance
        ? {
            policy_version: params.governance.policy_version,
            promotion_required: params.governance.promotion_required,
            matched_rule_ids: params.governance.matched_rule_ids || [],
            mandatory_triggers: params.governance.mandatory_triggers || [],
            accumulation_triggers: params.governance.accumulation_triggers || [],
          }
        : undefined,
    },
    null,
    2
  );
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

function structuredSurfaceQueryText(context: {
  input: { surfaceText?: string; query?: string; threadContext?: string };
  structuredQuery?: string;
}): string {
  const baseText = context.input.surfaceText || context.input.query || context.structuredQuery || '';
  const contextualText = context.input.threadContext
    ? `${context.input.threadContext}\n\nCurrent incoming message:\n${baseText}`
    : baseText;
  return contextualText.trim();
}

function resolvedSurfaceIntent(context: {
  input: { surfaceText?: string; query?: string; threadContext?: string };
  structuredQuery?: string;
  resolvedIntent?: ReturnType<typeof resolveSurfaceIntent>;
}): ReturnType<typeof resolveSurfaceIntent> {
  return context.resolvedIntent || resolveSurfaceIntent(structuredSurfaceQueryText(context));
}

function deriveSurfaceQueryRole(context: { input: { surface?: string } }): string | undefined {
  const surface = context.input.surface;
  if (!surface) return undefined;
  return `${surface.replace(/-/g, '_')}_surface_agent`;
}

export {
  attachRoutingDecision,
  buildDelegatedSurfaceConversationResult,
  extractDuckDuckGoResults,
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
  stripHtmlTags,
  decodeHtmlEntities,
};
