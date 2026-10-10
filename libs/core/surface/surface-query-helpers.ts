import {
  buildScopedIndex,
  DEFAULT_SCOPE,
  type KnowledgeHintIndex,
  type KnowledgeScope,
} from '../knowledge/knowledge-index.js';
import { secureFetch } from '../network.js';
import { resolveFallbackLocationSummary } from '../location-fallback.js';
import {
  buildContextualIntentFrame,
  type ContextualIntentFrame,
} from '../contextual-intent-frame.js';
import { assessContextualClarification } from '../contextual-intent-clarification-policy.js';
import {
  recordSchedulePreference,
  resolveDefaultScheduleSource,
} from '../contextual-intent-memory.js';
import { recordConversationSignal } from '../intent/conversation-signals.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';
import { resolveSurfaceIntent } from '../router-contract.js';
import type { IntentResolutionPacket } from '../intent/intent-resolution.js';
import { getSurfaceQueryProviderConfig } from './surface-query.js';
import { currentScope } from '../scope-context.js';
import { safeExec } from '../secure-io.js';
import { logger } from '../core.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import type {
  SurfaceConversationResult,
  SurfaceDelegationResult,
} from './channel-surface-types.js';
import type { UserIntentFlow } from '../intent/intent-contract.js';
import { t } from '../t.js';
import { localeToBcp47, resolveLocale, type SupportedLocale } from '../locale.js';

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
      return {
        start: thisWeekStart,
        end: new Date(thisWeekStart.getTime() + 7 * dayMs - 1),
        label: 'this_week',
      };
    case 'next_week':
      return {
        start: nextWeekStart,
        end: new Date(nextWeekStart.getTime() + 7 * dayMs - 1),
        label: 'next_week',
      };
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

export function formatCalendarAgendaReply(params: {
  sourceLabel: string;
  sourceName?: string;
  rangeLabel: string;
  events: Array<{ title: string; start: string; end: string; calendar?: string }>;
  assumption?: string;
  locale?: SupportedLocale;
}): { text: string; omitted_count: number } {
  const locale = params.locale ?? resolveLocale();
  const dateLocale = localeToBcp47(locale);
  const header = params.sourceName
    ? `${params.sourceLabel} / ${params.sourceName}`
    : params.sourceLabel;
  if (params.events.length === 0) {
    return {
      text: [
        params.assumption ? `${params.assumption}` : '',
        `Provider: ${header}`,
        t('surface:agenda_none', { range: params.rangeLabel }, locale),
      ]
        .filter(Boolean)
        .join('\n'),
      omitted_count: 0,
    };
  }
  const visibleEvents = params.events.slice(0, 10);
  const omittedCount = Math.max(0, params.events.length - visibleEvents.length);
  if (omittedCount > 0) {
    logger.info(
      `[surface-query-helpers] omitted ${omittedCount} agenda event(s) for ${header} ${params.rangeLabel}`
    );
  }
  const lines = [
    ...(params.assumption ? [params.assumption] : []),
    `Provider: ${header}`,
    t('surface:agenda_header', { range: params.rangeLabel }, locale),
    ...visibleEvents.map((event) => {
      const start = new Date(event.start);
      const end = new Date(event.end);
      const time = `${start.toLocaleString(dateLocale, { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}`;
      const calendar = event.calendar ? ` (${event.calendar})` : '';
      return `- ${time} ${event.title}${calendar}`;
    }),
  ];
  return {
    text: lines.join('\n'),
    omitted_count: omittedCount,
  };
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
}): Promise<
  Array<{
    title: string;
    start: string;
    end: string;
    calendar: string;
    location: string;
    description: string;
  }>
> {
  const startInput = parseCalendarDate(params.start_date, 'start_date');
  const endInput = parseCalendarDate(params.end_date, 'end_date');
  const start = startInput ?? new Date();
  if (!startInput) start.setHours(0, 0, 0, 0);
  const end = endInput ?? new Date(start.getTime() + 24 * 60 * 60 * 1000);
  if (!endInput) end.setHours(23, 59, 59, 999);
  if (end.getTime() <= start.getTime()) {
    throw new Error(
      `calendar query: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`
    );
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
  const parsed = parseSafeJsonInput(trimmed, 'Calendar query response');
  return Array.isArray(parsed) ? parsed : [];
}

/** The read-only agenda turn's outcome, in the conversation signal ledger. */
function recordAgendaSignal(
  kind: 'turn_succeeded' | 'turn_failed',
  utterance: string,
  clarificationNeeded: boolean,
  detail: Record<string, string | number>
): void {
  let tenant: string | undefined;
  try {
    tenant = currentScope().tenant_slug;
  } catch {
    tenant = undefined;
  }
  recordConversationSignal({
    kind,
    utterance,
    intentId: 'schedule-read-agenda',
    scope: { tenant_slug: tenant },
    detail: {
      shape: 'calendar_agenda_summary',
      clarification_needed: clarificationNeeded,
      ...detail,
    },
  });
}

async function readScheduleAgenda(
  queryText: string,
  contextualFrame?: ContextualIntentFrame
): Promise<string> {
  const frame = contextualFrame || buildContextualIntentFrame(queryText);
  const clarificationDecision = assessContextualClarification({
    intentId: 'schedule-read-agenda',
    text: queryText,
    executionShape: 'direct_reply',
    requiredInputs:
      frame.missing.length > 0 ? frame.missing : frame.date_range ? [] : ['date_range'],
    confidence: frame.confidence,
    contextualFrame: frame,
  });
  const scheduleSource =
    frame.source_binding.selected || resolveDefaultScheduleSource().source || 'browser_calendar';
  const calendarName = resolveDefaultScheduleSource().calendarName;
  const range = getScheduleDateRange(frame.date_range?.value);
  const assumption = [
    frame.subject === 'operator_self' ? t('surface:agenda_assume_self') : '',
    frame.date_range ? '' : t('surface:agenda_assume_range', { range: range.label }),
  ]
    .filter(Boolean)
    .join(' ');

  try {
    const events = await listCalendarEvents({
      ...(calendarName ? { calendar_names: [calendarName] } : {}),
      start_date: range.start.toISOString(),
      end_date: range.end.toISOString(),
    });
    if (frame.source_binding.selected) {
      recordSchedulePreference({
        source: frame.source_binding.selected,
        calendarName,
        utterance: queryText,
        confirmed: true,
      });
    }
    const agendaReply = formatCalendarAgendaReply({
      sourceLabel: scheduleSource,
      sourceName: calendarName,
      rangeLabel: range.label,
      events: Array.isArray(events) ? events : [],
      assumption,
    });
    recordAgendaSignal('turn_succeeded', queryText, clarificationDecision.shouldClarify, {
      events: Array.isArray(events) ? events.length : 0,
      omitted: agendaReply.omitted_count,
    });
    return agendaReply.text;
  } catch (error: any) {
    recordAgendaSignal('turn_failed', queryText, clarificationDecision.shouldClarify, {
      error: error?.message || String(error),
    });
    if (frame.source_binding.selected) {
      recordSchedulePreference({
        source: frame.source_binding.selected,
        calendarName,
        utterance: queryText,
        confirmed: false,
      });
    }
    return `Provider: ${scheduleSource}${calendarName ? ` / ${calendarName}` : ''}\n${t('surface:agenda_read_failed', { range: range.label, error: error?.message || String(error) })}`;
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
  routingDecision?: UserIntentFlow['routingDecision']
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
      ts: nowIso(),
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
  // `&amp;` is decoded last so entity text like `&amp;lt;` is not unescaped
  // into a second entity and decoded twice.
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractDuckDuckGoResults(
  html: string,
  limit = 3
): Array<{ title: string; url: string; snippet?: string }> {
  const anchors = [
    ...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g),
  ];
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
    .replace(
      /(今日|今|現在|明日|この|その|あの)?(の)?(天気|weather|forecast|気温|降水確率|雨|晴れ|天候)/gi,
      ' '
    )
    .replace(/(を)?(教えて|知りたい|見せて|検索して|調べて|お願いします|please)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  if (/^(です|ます|ください|please|weather|forecast)$/i.test(stripped)) return null;
  return stripped;
}

export interface SurfaceWeatherGeocodeCandidate {
  name?: string;
  latitude: number;
  longitude: number;
}

export interface SurfaceWeatherCurrent {
  temperature_2m?: number;
  weather_code?: number;
  wind_speed_10m?: number;
  relative_humidity_2m?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface SurfaceWeatherGeocodeResponseFields {
  results_path?: string;
  name_path?: string;
  latitude_path?: string;
  longitude_path?: string;
  coerce_numeric_strings?: boolean;
}

export interface SurfaceWeatherForecastResponseFields {
  current_path?: string;
  temperature_path?: string;
  weather_code_path?: string;
  wind_speed_path?: string;
  humidity_path?: string;
  coerce_numeric_strings?: boolean;
}

function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mappedFiniteNumber(value: unknown, coerceNumericStrings = false): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined || !coerceNumericStrings || typeof value !== 'string') return numeric;
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSurfaceWeatherGeocodeResponse(
  value: unknown,
  fields: SurfaceWeatherGeocodeResponseFields = {}
): SurfaceWeatherGeocodeCandidate[] | undefined {
  const entries = valueAtPath(value, fields.results_path ?? 'results');
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((entry): SurfaceWeatherGeocodeCandidate[] => {
    if (!isRecord(entry)) return [];
    const latitude = mappedFiniteNumber(
      valueAtPath(entry, fields.latitude_path ?? 'latitude'),
      fields.coerce_numeric_strings
    );
    const longitude = mappedFiniteNumber(
      valueAtPath(entry, fields.longitude_path ?? 'longitude'),
      fields.coerce_numeric_strings
    );
    if (latitude === undefined || longitude === undefined) return [];
    const name = valueAtPath(entry, fields.name_path ?? 'name');
    return [
      {
        ...(typeof name === 'string' && name.trim() ? { name } : {}),
        latitude,
        longitude,
      },
    ];
  });
}

export function parseSurfaceWeatherForecastResponse(
  value: unknown,
  fields: SurfaceWeatherForecastResponseFields = {}
): { current: SurfaceWeatherCurrent } | undefined {
  const currentValue = valueAtPath(value, fields.current_path ?? 'current');
  if (!isRecord(currentValue)) return undefined;
  const current: SurfaceWeatherCurrent = {};
  const temperature = mappedFiniteNumber(
    valueAtPath(currentValue, fields.temperature_path ?? 'temperature_2m'),
    fields.coerce_numeric_strings
  );
  const weatherCode = mappedFiniteNumber(
    valueAtPath(currentValue, fields.weather_code_path ?? 'weather_code'),
    fields.coerce_numeric_strings
  );
  const wind = mappedFiniteNumber(
    valueAtPath(currentValue, fields.wind_speed_path ?? 'wind_speed_10m'),
    fields.coerce_numeric_strings
  );
  const humidity = mappedFiniteNumber(
    valueAtPath(currentValue, fields.humidity_path ?? 'relative_humidity_2m'),
    fields.coerce_numeric_strings
  );
  if (temperature !== undefined) current.temperature_2m = temperature;
  if (weatherCode !== undefined) current.weather_code = weatherCode;
  if (wind !== undefined) current.wind_speed_10m = wind;
  if (humidity !== undefined) current.relative_humidity_2m = humidity;
  return { current };
}

async function fetchWeatherSummary(queryText: string): Promise<string> {
  const locationHint = extractLocationHint(queryText);
  let latitude: number | undefined;
  let longitude: number | undefined;
  let label = locationHint || '';
  const providerConfig = getSurfaceQueryProviderConfig({ scope: currentScope() });
  const weatherConfig = providerConfig.weather || {};
  const geocodingUrl = weatherConfig.geocodingUrl;
  const forecastUrl = weatherConfig.forecastUrl;

  if (locationHint) {
    if (!geocodingUrl) {
      throw new Error('weather geocoding endpoint is not configured');
    }
    const geocode = parseSurfaceWeatherGeocodeResponse(
      await secureFetch<unknown>({
        method: 'GET',
        url: geocodingUrl,
        params: {
          ...(weatherConfig.geocoding?.query_values || {}),
          [weatherConfig.geocoding?.query_keys?.query || 'name']: locationHint,
          [weatherConfig.geocoding?.query_keys?.count || 'count']: 1,
          [weatherConfig.geocoding?.query_keys?.language || 'language']: resolveLocale(),
          [weatherConfig.geocoding?.query_keys?.format || 'format']: 'json',
        },
      }),
      weatherConfig.geocoding?.response_fields
    );
    const candidate = geocode?.[0];
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

  const weather = parseSurfaceWeatherForecastResponse(
    await secureFetch<unknown>({
      method: 'GET',
      url: forecastUrl,
      params: {
        ...(weatherConfig.forecast?.query_values || {}),
        [weatherConfig.forecast?.query_keys?.latitude || 'latitude']: latitude,
        [weatherConfig.forecast?.query_keys?.longitude || 'longitude']: longitude,
        [weatherConfig.forecast?.query_keys?.current || 'current']: (
          weatherConfig.forecast?.current_fields || [
            'temperature_2m',
            'weather_code',
            'wind_speed_10m',
            'relative_humidity_2m',
          ]
        ).join(','),
        [weatherConfig.forecast?.query_keys?.timezone || 'timezone']: 'auto',
      },
    }),
    weatherConfig.forecast?.response_fields
  );
  const current = weather?.current || {};
  const temperature = current.temperature_2m;
  const weatherCode = current.weather_code;
  const wind = current.wind_speed_10m;
  const humidity = current.relative_humidity_2m;

  return [
    `Weather for ${label}:`,
    typeof temperature === 'number'
      ? `temperature ${temperature} ${weatherConfig.forecast?.display_units?.temperature || '°C'}`
      : 'temperature unavailable',
    weatherCode !== undefined
      ? `code ${weatherConfig.forecast?.weather_code_labels?.[String(weatherCode)] || weatherCode}`
      : 'weather code unavailable',
    typeof wind === 'number'
      ? `wind ${wind} ${weatherConfig.forecast?.display_units?.wind_speed || 'km/h'}`
      : 'wind unavailable',
    typeof humidity === 'number'
      ? `humidity ${humidity} ${weatherConfig.forecast?.display_units?.humidity || '%'}`
      : 'humidity unavailable',
  ].join(', ');
}

interface SurfaceWebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface SurfaceWebSearchResponseFields {
  results_path?: string;
  title_path?: string;
  url_path?: string;
  snippet_path?: string;
}

function parseSurfaceWebSearchJson(
  value: unknown,
  fields: SurfaceWebSearchResponseFields,
  limit: number
): SurfaceWebSearchResult[] {
  const results = valueAtPath(value, fields.results_path ?? 'results');
  if (!Array.isArray(results)) return [];
  return results
    .flatMap((entry): SurfaceWebSearchResult[] => {
      if (!isRecord(entry)) return [];
      const title = valueAtPath(entry, fields.title_path ?? 'title');
      const url = valueAtPath(entry, fields.url_path ?? 'url');
      const snippet = valueAtPath(entry, fields.snippet_path ?? 'snippet');
      if (typeof title !== 'string' || typeof url !== 'string') return [];
      return [{ title, url, ...(typeof snippet === 'string' && snippet ? { snippet } : {}) }];
    })
    .slice(0, limit);
}

async function runWebSearch(queryText: string): Promise<string> {
  const config = getSurfaceQueryProviderConfig({ scope: currentScope() }).web_search || {};
  const responseFormat = config.response_format || 'duckduckgo_html';
  const response = await secureFetch<unknown>({
    method: 'GET',
    url: config.url || 'https://html.duckduckgo.com/html/',
    params: {
      ...(config.query_values || {}),
      [config.query_keys?.query || 'q']: queryText,
      ...(config.query_keys?.limit ? { [config.query_keys.limit]: config.maxResults || 3 } : {}),
    },
  });
  const limit = Math.max(1, Math.min(20, Math.floor(config.maxResults || 3)));
  const results =
    responseFormat === 'json'
      ? parseSurfaceWebSearchJson(response, config.response_fields || {}, limit)
      : extractDuckDuckGoResults(String(response ?? ''), limit);
  if (results.length === 0) return 'No web search results were parsed for: ' + queryText;
  return [
    'Web search results for: ' + queryText,
    ...results.map((result, index) => {
      const snippet = result.snippet ? '\n  ' + result.snippet : '';
      return index + 1 + '. ' + result.title + '\n   ' + result.url + snippet;
    }),
  ].join('\n');
}
let knowledgeIndexPromise: Promise<KnowledgeHintIndex> | null = null;
let _lastScope: KnowledgeScope | null = null;

async function loadKnowledgeHintIndex(
  scope: KnowledgeScope = DEFAULT_SCOPE
): Promise<KnowledgeHintIndex> {
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
  const baseText =
    context.input.surfaceText || context.input.query || context.structuredQuery || '';
  const contextualText = context.input.threadContext
    ? `${context.input.threadContext}\n\nCurrent incoming message:\n${baseText}`
    : baseText;
  return contextualText.trim();
}

function resolvedSurfaceIntent(context: {
  input: {
    surfaceText?: string;
    query?: string;
    threadContext?: string;
    scope?: { tier?: 'personal' | 'confidential' | 'public'; tenant_slug?: string };
  };
  structuredQuery?: string;
  resolvedIntent?: ReturnType<typeof resolveSurfaceIntent>;
  resolutionPacket?: IntentResolutionPacket;
}): ReturnType<typeof resolveSurfaceIntent> {
  return (
    context.resolvedIntent ||
    resolveSurfaceIntent(structuredSurfaceQueryText(context), {
      tier: context.input.scope?.tier,
      tenantId: context.input.scope?.tenant_slug,
      packet: context.resolutionPacket,
    })
  );
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
