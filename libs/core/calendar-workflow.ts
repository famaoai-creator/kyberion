import { randomUUID } from 'node:crypto';
import { executeServicePreset } from './service-engine.js';
import { clamp, isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';

export { readGwsAuthStatus } from './email-workflow.js';

export type CalendarProvider = 'google-workspace' | 'm365';

export interface CalendarAgendaInput {
  provider?: CalendarProvider;
  calendar_id?: string;
  days?: number;
  max_results?: number;
  query?: string;
  time_max?: string;
  time_min?: string;
  time_zone?: string;
}

export interface CalendarFreeBusyInput {
  provider?: CalendarProvider;
  calendar_id?: string;
  calendar_ids?: string[];
  time_max: string;
  time_min: string;
  time_zone?: string;
}

export interface CalendarEventCreateInput {
  attendees?: string[];
  provider?: CalendarProvider;
  calendar_id?: string;
  conference_request_id?: string;
  description?: string;
  end: string;
  location?: string;
  send_updates?: 'all' | 'externalOnly' | 'none';
  start: string;
  summary: string;
  time_zone?: string;
  with_meet?: boolean;
}

export interface CalendarEventSummary {
  end: string;
  hangout_link: string;
  html_link: string;
  id: string;
  location: string;
  start: string;
  status: string;
  summary: string;
}

export interface CalendarAgendaResult {
  calendar_id: string;
  events: CalendarEventSummary[];
  max_results: number;
  ok: boolean;
  query: string;
  time_max: string;
  time_min: string;
  time_zone?: string;
  total_items: number;
}

export interface CalendarListEntry {
  access_role: string;
  description: string;
  id: string;
  primary: boolean;
  selected: boolean;
  summary: string;
  time_zone: string;
}

export interface CalendarListResult {
  calendars: CalendarListEntry[];
  ok: boolean;
  total_items: number;
}

export interface CalendarFreeBusyWindow {
  busy: Array<{ end: string; start: string }>;
  calendar_id: string;
  errors: string[];
}

export interface CalendarFreeBusyResult {
  calendars: CalendarFreeBusyWindow[];
  ok: boolean;
  time_max: string;
  time_min: string;
  time_zone?: string;
}

export interface CalendarEventCreateResult {
  calendar_id: string;
  conference_request_id?: string;
  created_event: CalendarEventSummary;
  ok: boolean;
  with_meet: boolean;
}

export async function readM365AuthStatus(): Promise<{
  ok: boolean;
  available: boolean;
  raw: unknown;
  error?: string;
}> {
  try {
    const raw = await executeServicePreset('m365', 'auth_status', { params: {} });
    return {
      ok: true,
      available: true,
      raw,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      available: false,
      raw: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nestedStringValue(value: unknown, parentKey: string, childKey: string): string {
  if (!isRecord(value) || !isRecord(value[parentKey])) return '';
  return stringValue(value[parentKey][childKey]);
}

function normalizeRfc3339Value(value: string, timeZone?: string): Record<string, string> {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { date: trimmed };
  }

  return timeZone ? { dateTime: trimmed, timeZone } : { dateTime: trimmed };
}

function normalizeEvent(item: unknown): CalendarEventSummary | null {
  if (!isRecord(item) || !nonEmptyString(item.id)) return null;
  return {
    id: item.id,
    summary: stringValue(item.summary),
    start: nestedStringValue(item, 'start', 'dateTime') || nestedStringValue(item, 'start', 'date'),
    end: nestedStringValue(item, 'end', 'dateTime') || nestedStringValue(item, 'end', 'date'),
    location: stringValue(item.location),
    status: stringValue(item.status),
    html_link: stringValue(item.htmlLink),
    hangout_link: stringValue(item.hangoutLink),
  };
}

function extractEventItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items;
  }
  if (isRecord(payload) && Array.isArray(payload.value)) {
    return payload.value;
  }
  return [];
}

function extractCalendarListItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.items)) {
    return payload.items;
  }
  if (isRecord(payload) && Array.isArray(payload.value)) {
    return payload.value;
  }
  return [];
}

function extractFreeBusyWindows(payload: unknown): CalendarFreeBusyWindow[] {
  if (isRecord(payload) && Array.isArray(payload.value)) {
    return payload.value
      .map((calendar) => {
        const busy =
          isRecord(calendar) && Array.isArray(calendar.scheduleItems)
            ? calendar.scheduleItems.map((window) => ({
                start: nestedStringValue(window, 'start', 'dateTime'),
                end: nestedStringValue(window, 'end', 'dateTime'),
              }))
            : [];
        return {
          calendar_id: isRecord(calendar)
            ? stringValue(calendar.scheduleId) || stringValue(calendar.id)
            : '',
          busy,
          errors:
            isRecord(calendar) && Array.isArray(calendar.error)
              ? calendar.error.filter((error): error is string => typeof error === 'string')
              : [],
        };
      })
      .filter((calendar) => nonEmptyString(calendar.calendar_id));
  }

  const calendars =
    isRecord(payload) && isRecord(payload.calendars) ? payload.calendars : undefined;
  if (!calendars) {
    return [];
  }

  return Object.entries(calendars)
    .map(([calendar_id, value]) => {
      const busy =
        isRecord(value) && Array.isArray(value.busy)
          ? value.busy.map((window) => ({
              start: isRecord(window) ? stringValue(window.start) : '',
              end: isRecord(window) ? stringValue(window.end) : '',
            }))
          : [];
      const errors =
        isRecord(value) && Array.isArray(value.errors)
          ? value.errors.filter((error): error is string => typeof error === 'string')
          : [];

      return { calendar_id, busy, errors };
    })
    .filter((calendar) => nonEmptyString(calendar.calendar_id));
}

function resolveProvider(provider?: CalendarProvider): CalendarProvider {
  return provider || 'google-workspace';
}

function resolveCalendarPath(calendarId: string | undefined, provider: CalendarProvider): string {
  const trimmed = calendarId?.trim();
  if (provider === 'm365') {
    if (!trimmed || trimmed === 'primary' || trimmed === 'me') return 'me';
    return `me/calendars/${trimmed}`;
  }
  return trimmed || 'primary';
}

function normalizeGraphEvent(item: unknown): CalendarEventSummary | null {
  if (!isRecord(item) || !nonEmptyString(item.id)) return null;
  const location = isRecord(item.location) ? item.location : undefined;
  const onlineMeeting = isRecord(item.onlineMeeting) ? item.onlineMeeting : undefined;
  return {
    id: item.id,
    summary: stringValue(item.subject) || stringValue(item.summary),
    start: nestedStringValue(item, 'start', 'dateTime') || nestedStringValue(item, 'start', 'date'),
    end: nestedStringValue(item, 'end', 'dateTime') || nestedStringValue(item, 'end', 'date'),
    location: stringValue(location?.displayName) || stringValue(item.location),
    status: stringValue(item.showAs) || stringValue(item.status),
    html_link: stringValue(item.webLink),
    hangout_link: stringValue(item.onlineMeetingUrl) || stringValue(onlineMeeting?.joinUrl),
  };
}

function normalizeCalendarListEntry(item: unknown): CalendarListEntry | null {
  if (!isRecord(item) || !nonEmptyString(item.id)) return null;
  return {
    id: item.id,
    summary: stringValue(item.summary) || stringValue(item.name),
    description: stringValue(item.description),
    time_zone: stringValue(item.timeZone) || stringValue(item.timezone),
    access_role: stringValue(item.accessRole) || (item.canEdit === true ? 'owner' : ''),
    selected: item.selected === true,
    primary: item.primary === true || item.isDefaultCalendar === true,
  };
}

function isCalendarEventSummary(value: CalendarEventSummary | null): value is CalendarEventSummary {
  return value !== null;
}

function isCalendarListEntry(value: CalendarListEntry | null): value is CalendarListEntry {
  return value !== null;
}

function requireCalendarEvent(value: CalendarEventSummary | null): CalendarEventSummary {
  if (value === null) throw new Error('invalid_calendar_event_response');
  return value;
}

export async function listCalendarAgenda(
  input: CalendarAgendaInput = {}
): Promise<CalendarAgendaResult> {
  const provider = resolveProvider(input.provider);
  const calendarId = input.calendar_id?.trim() || 'primary';
  const currentTime = new Date();
  const timeMin = input.time_min?.trim() || nowIso(currentTime);
  const timeMax =
    input.time_max?.trim() ||
    nowIso(
      new Date(currentTime.getTime() + Math.max(1, Number(input.days) || 7) * 24 * 60 * 60 * 1000)
    );
  const maxResults = clamp(Number(input.max_results) || 20, 1, 250);
  const query = input.query?.trim() || '';
  const timeZone = input.time_zone?.trim() || '';
  const encodedTimeMin = encodeURIComponent(timeMin);
  const encodedTimeMax = encodeURIComponent(timeMax);

  const response =
    provider === 'm365'
      ? await executeServicePreset('m365', 'calendar_events_list', {
          params: {
            calendarPath: resolveCalendarPath(calendarId, provider),
            timeMin: encodedTimeMin,
            timeMax: encodedTimeMax,
            maxResults,
          },
        })
      : await executeServicePreset('google-workspace', 'calendar_events_list', {
          params: {
            calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults,
            ...(query ? { q: query } : {}),
            ...(timeZone ? { timeZone } : {}),
          },
        });

  const events = extractEventItems(response)
    .map(provider === 'm365' ? normalizeGraphEvent : normalizeEvent)
    .filter(isCalendarEventSummary);

  return {
    ok: true,
    calendar_id: calendarId,
    events,
    max_results: maxResults,
    query,
    time_min: timeMin,
    time_max: timeMax,
    ...(timeZone ? { time_zone: timeZone } : {}),
    total_items: events.length,
  };
}

export async function listCalendars(
  provider: CalendarProvider = 'google-workspace'
): Promise<CalendarListResult> {
  const resolvedProvider = resolveProvider(provider);
  const response =
    resolvedProvider === 'm365'
      ? await executeServicePreset('m365', 'calendar_list', {
          params: {},
        })
      : await executeServicePreset('google-workspace', 'calendar_calendarList_list', {
          params: {},
        });
  const calendars = extractCalendarListItems(response)
    .map(normalizeCalendarListEntry)
    .filter(isCalendarListEntry);

  return {
    ok: true,
    calendars,
    total_items: calendars.length,
  };
}

export async function queryCalendarFreeBusy(
  input: CalendarFreeBusyInput
): Promise<CalendarFreeBusyResult> {
  const provider = resolveProvider(input.provider);
  const calendarIds = (
    input.calendar_ids && input.calendar_ids.length
      ? input.calendar_ids
      : [input.calendar_id || 'primary']
  )
    .map((calendarId) => calendarId.trim())
    .filter(Boolean);
  const timeZone = input.time_zone?.trim() || '';

  const response =
    provider === 'm365'
      ? await executeServicePreset('m365', 'calendar_freebusy_query', {
          body: {
            schedules: calendarIds,
            startTime: {
              dateTime: input.time_min,
              ...(timeZone ? { timeZone } : {}),
            },
            endTime: {
              dateTime: input.time_max,
              ...(timeZone ? { timeZone } : {}),
            },
            availabilityViewInterval: 30,
          },
        })
      : await executeServicePreset('google-workspace', 'calendar_freebusy_query', {
          body: {
            timeMin: input.time_min,
            timeMax: input.time_max,
            ...(timeZone ? { timeZone } : {}),
            items: calendarIds.map((calendarId) => ({ id: calendarId })),
          },
        });

  return {
    ok: true,
    calendars: extractFreeBusyWindows(response),
    time_min: input.time_min,
    time_max: input.time_max,
    ...(timeZone ? { time_zone: timeZone } : {}),
  };
}

export async function createCalendarEvent(
  input: CalendarEventCreateInput
): Promise<CalendarEventCreateResult> {
  const provider = resolveProvider(input.provider);
  const calendarId = input.calendar_id?.trim() || 'primary';
  const summary = input.summary.trim();
  const start = input.start.trim();
  const end = input.end.trim();
  if (!summary) {
    throw new Error('summary is required');
  }
  if (!start || !end) {
    throw new Error('start and end are required');
  }

  const timeZone = input.time_zone?.trim() || '';
  const withMeet = input.with_meet === true;
  const conferenceRequestId = withMeet
    ? input.conference_request_id?.trim() || randomUUID()
    : undefined;

  const response =
    provider === 'm365'
      ? await executeServicePreset('m365', 'calendar_events_insert', {
          params: {
            calendarPath: resolveCalendarPath(calendarId, provider),
          },
          body: {
            subject: summary,
            start: normalizeRfc3339Value(start, timeZone || undefined),
            end: normalizeRfc3339Value(end, timeZone || undefined),
            ...(input.description?.trim()
              ? { body: { contentType: 'text', content: input.description.trim() } }
              : {}),
            ...(input.location?.trim() ? { location: { displayName: input.location.trim() } } : {}),
            ...(input.attendees?.length
              ? {
                  attendees: input.attendees
                    .map((attendee) => attendee.trim())
                    .filter(Boolean)
                    .map((email) => ({
                      emailAddress: { address: email },
                      type: 'required',
                    })),
                }
              : {}),
            ...(withMeet
              ? {
                  isOnlineMeeting: true,
                  onlineMeetingProvider: 'teamsForBusiness',
                }
              : {}),
          },
        })
      : await executeServicePreset('google-workspace', 'calendar_events_insert', {
          params: {
            calendarId,
            ...(input.send_updates ? { sendUpdates: input.send_updates } : {}),
            ...(withMeet ? { conferenceDataVersion: 1 } : {}),
          },
          body: {
            summary,
            start: normalizeRfc3339Value(start, timeZone || undefined),
            end: normalizeRfc3339Value(end, timeZone || undefined),
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.location?.trim() ? { location: input.location.trim() } : {}),
            ...(input.attendees?.length
              ? {
                  attendees: input.attendees
                    .map((attendee) => attendee.trim())
                    .filter(Boolean)
                    .map((email) => ({ email })),
                }
              : {}),
            ...(withMeet && conferenceRequestId
              ? {
                  conferenceData: {
                    createRequest: {
                      requestId: conferenceRequestId,
                      conferenceSolutionKey: {
                        type: 'hangoutsMeet',
                      },
                    },
                  },
                }
              : {}),
          },
        });

  return {
    ok: true,
    calendar_id: calendarId,
    ...(conferenceRequestId ? { conference_request_id: conferenceRequestId } : {}),
    with_meet: withMeet,
    created_event: requireCalendarEvent(
      provider === 'm365' ? normalizeGraphEvent(response) : normalizeEvent(response)
    ),
  };
}
