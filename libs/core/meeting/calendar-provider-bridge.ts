/**
 * Calendar-provider seam — Google Workspace / M365 calendar backends.
 *
 * calendar-workflow resolves a provider by id; vendor service-preset shapes
 * stay inside the registered adapters.
 */

import { executeServicePreset } from '../service/service-engine.js';
import { readGwsAuthStatus } from '../integrations/email-workflow.js';
import { isRecord } from '../foundation/text.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export interface CalendarEventSummary {
  end: string;
  hangout_link: string;
  html_link: string;
  id: string;
  description?: string;
  location: string;
  start: string;
  status: string;
  summary: string;
}

export interface CalendarFreeBusyWindow {
  busy: Array<{ end: string; start: string }>;
  calendar_id: string;
  errors: string[];
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

export type CalendarProviderId = 'google-workspace' | 'm365' | (string & {});

export interface CalendarProviderListEventsParams {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  maxResults: number;
  query?: string;
  timeZone?: string;
  encodedTimeMin: string;
  encodedTimeMax: string;
}

export interface CalendarProviderFreeBusyParams {
  calendarIds: string[];
  timeMin: string;
  timeMax: string;
  timeZone?: string;
}

export interface CalendarProviderInsertEventParams {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: Record<string, string>;
  end: Record<string, string>;
  attendees?: string[];
  withMeet?: boolean;
  conferenceRequestId?: string;
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

export interface CalendarProviderUpdateEventParams {
  calendarId: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: Record<string, string>;
  end?: Record<string, string>;
  attendees?: string[];
  reminderMinutesBeforeStart?: number;
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

export interface CalendarProviderDeleteEventParams {
  calendarId: string;
  eventId: string;
  sendUpdates?: 'all' | 'externalOnly' | 'none';
}

export interface CalendarProviderAuthStatus {
  ok: boolean;
  available: boolean;
  raw: unknown;
  error?: string;
}

export interface CalendarProviderBridge {
  readonly provider_id: CalendarProviderId;
  resolveCalendarPath(calendarId?: string): string;
  readAuthStatus?(): CalendarProviderAuthStatus | Promise<CalendarProviderAuthStatus>;
  listEvents(params: CalendarProviderListEventsParams): Promise<unknown>;
  /** Convert provider wire events to the workflow canonical shape. */
  normalizeEvent?(value: unknown): CalendarEventSummary | null;
  normalizeEvents?(value: unknown): CalendarEventSummary[];
  normalizeCalendarList?(value: unknown): CalendarListEntry[];
  listCalendars(): Promise<unknown>;
  queryFreeBusy(params: CalendarProviderFreeBusyParams): Promise<unknown>;
  /** Convert provider free/busy wire output into canonical calendar windows. */
  normalizeFreeBusy?(value: unknown): CalendarFreeBusyWindow[];
  insertEvent(params: CalendarProviderInsertEventParams): Promise<unknown>;
  updateEvent?(params: CalendarProviderUpdateEventParams): Promise<unknown>;
  deleteEvent?(params: CalendarProviderDeleteEventParams): Promise<unknown>;
}

const calendarProviderSeam = createSeam<CalendarProviderBridge>({
  key: 'calendar-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
  owner: 'libs/core/meeting/calendar-provider-bridge.ts',
});

const registeredDisposers = new Map<string, () => void>();
let builtinsRegistered = false;

export function registerCalendarProvider(
  bridge: CalendarProviderBridge,
  metadata: SeamProviderMetadata = {
    provenance: 'plugin',
    source: 'calendar-provider-extension',
  }
): () => void {
  const id = String(bridge.provider_id || '').trim();
  if (!id) throw new Error('CalendarProviderBridge.provider_id is required');
  const disposeFromSeam = calendarProviderSeam.register(id, bridge, metadata);
  const dispose = () => {
    disposeFromSeam();
    if (registeredDisposers.get(id) === dispose) registeredDisposers.delete(id);
  };
  registeredDisposers.set(id, dispose);
  return dispose;
}

export function listCalendarProviders(): CalendarProviderBridge[] {
  registerBuiltinCalendarProviders();
  return calendarProviderSeam.list().map((entry) => entry.implementation);
}

export function resetCalendarProviders(): void {
  for (const dispose of registeredDisposers.values()) {
    try {
      dispose();
    } catch {
      /* noop */
    }
  }
  registeredDisposers.clear();
  builtinsRegistered = false;
}

function calendarText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function calendarNestedText(value: unknown, parent: string, child: string): string {
  if (!isRecord(value) || !isRecord(value[parent])) return '';
  return calendarText(value[parent][child]);
}
function normalizeM365CalendarEvent(item: unknown): CalendarEventSummary | null {
  if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) return null;
  const location = isRecord(item.location) ? item.location : undefined;
  const onlineMeeting = isRecord(item.onlineMeeting) ? item.onlineMeeting : undefined;
  const description =
    calendarNestedText(item, 'body', 'content') ||
    calendarText(item.bodyPreview) ||
    calendarText(item.description);
  return {
    id: item.id,
    summary: calendarText(item.subject) || calendarText(item.summary),
    ...(description ? { description } : {}),
    start:
      calendarNestedText(item, 'start', 'dateTime') || calendarNestedText(item, 'start', 'date'),
    end: calendarNestedText(item, 'end', 'dateTime') || calendarNestedText(item, 'end', 'date'),
    location: calendarText(location?.displayName) || calendarText(item.location),
    status: calendarText(item.showAs) || calendarText(item.status),
    html_link: calendarText(item.webLink),
    hangout_link: calendarText(item.onlineMeetingUrl) || calendarText(onlineMeeting?.joinUrl),
  };
}
function normalizeM365FreeBusy(value: unknown): CalendarFreeBusyWindow[] {
  if (!isRecord(value) || !Array.isArray(value.value)) return [];
  return value.value
    .map((calendar: unknown) => {
      const busy =
        isRecord(calendar) && Array.isArray(calendar.scheduleItems)
          ? calendar.scheduleItems.map((window: unknown) => ({
              start: calendarNestedText(window, 'start', 'dateTime'),
              end: calendarNestedText(window, 'end', 'dateTime'),
            }))
          : [];
      return {
        calendar_id: isRecord(calendar)
          ? calendarText(calendar.scheduleId) || calendarText(calendar.id)
          : '',
        busy,
        errors:
          isRecord(calendar) && Array.isArray(calendar.error)
            ? calendar.error.filter((error: unknown): error is string => typeof error === 'string')
            : [],
      };
    })
    .filter((calendar) => calendar.calendar_id.trim().length > 0);
}
function providerListItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.value)) return value.value;
  return [];
}

function normalizeM365CalendarEvents(value: unknown): CalendarEventSummary[] {
  return providerListItems(value)
    .map(normalizeM365CalendarEvent)
    .filter((event): event is CalendarEventSummary => event !== null);
}

function normalizeM365CalendarList(value: unknown): CalendarListEntry[] {
  return providerListItems(value)
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.id === 'string' && item.id.trim().length > 0
    )
    .map((item) => ({
      id: item.id as string,
      summary: calendarText(item.summary) || calendarText(item.name),
      description: calendarText(item.description),
      time_zone: calendarText(item.timeZone) || calendarText(item.timezone),
      access_role: calendarText(item.accessRole) || (item.canEdit === true ? 'owner' : ''),
      selected: item.selected === true,
      primary: item.primary === true || item.isDefaultCalendar === true,
    }));
}

async function readM365AuthStatus(): Promise<CalendarProviderAuthStatus> {
  try {
    const raw = await executeServicePreset('m365', 'auth_status', { params: {} });
    return { ok: true, available: true, raw };
  } catch (error: unknown) {
    return {
      ok: false,
      available: false,
      raw: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
function registerBuiltinCalendarProviders(): void {
  if (builtinsRegistered) return;

  registerCalendarProvider(
    {
      provider_id: 'google-workspace',
      readAuthStatus: () => {
        const status = readGwsAuthStatus();
        return { ...status, raw: status };
      },
      resolveCalendarPath(calendarId) {
        return calendarId?.trim() || 'primary';
      },
      async listEvents(params) {
        return executeServicePreset('google-workspace', 'calendar_events_list', {
          params: {
            calendarId: params.calendarId,
            timeMin: params.timeMin,
            timeMax: params.timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: params.maxResults,
            ...(params.query ? { q: params.query } : {}),
            ...(params.timeZone ? { timeZone: params.timeZone } : {}),
          },
        });
      },
      async listCalendars() {
        return executeServicePreset('google-workspace', 'calendar_calendarList_list', {
          params: {},
        });
      },
      async queryFreeBusy(params) {
        return executeServicePreset('google-workspace', 'calendar_freebusy_query', {
          body: {
            timeMin: params.timeMin,
            timeMax: params.timeMax,
            ...(params.timeZone ? { timeZone: params.timeZone } : {}),
            items: params.calendarIds.map((calendarId) => ({ id: calendarId })),
          },
        });
      },
      async insertEvent(params) {
        return executeServicePreset('google-workspace', 'calendar_events_insert', {
          params: {
            calendarId: params.calendarId,
            ...(params.sendUpdates ? { sendUpdates: params.sendUpdates } : {}),
            ...(params.withMeet ? { conferenceDataVersion: 1 } : {}),
          },
          body: {
            summary: params.summary,
            start: params.start,
            end: params.end,
            ...(params.description ? { description: params.description } : {}),
            ...(params.location ? { location: params.location } : {}),
            ...(params.attendees?.length
              ? { attendees: params.attendees.map((email) => ({ email })) }
              : {}),
            ...(params.withMeet && params.conferenceRequestId
              ? {
                  conferenceData: {
                    createRequest: {
                      requestId: params.conferenceRequestId,
                      conferenceSolutionKey: { type: 'hangoutsMeet' },
                    },
                  },
                }
              : {}),
          },
        });
      },
      async updateEvent(params) {
        return executeServicePreset('google-workspace', 'calendar_events_patch', {
          params: {
            calendarId: params.calendarId,
            eventId: params.eventId,
            ...(params.sendUpdates ? { sendUpdates: params.sendUpdates } : {}),
          },
          body: {
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.location !== undefined ? { location: params.location } : {}),
            ...(params.start ? { start: params.start } : {}),
            ...(params.end ? { end: params.end } : {}),
            ...(params.attendees
              ? { attendees: params.attendees.map((email) => ({ email })) }
              : {}),
            ...(params.reminderMinutesBeforeStart !== undefined
              ? {
                  reminders: {
                    useDefault: false,
                    overrides: [{ method: 'popup', minutes: params.reminderMinutesBeforeStart }],
                  },
                }
              : {}),
          },
        });
      },
      async deleteEvent(params) {
        return executeServicePreset('google-workspace', 'calendar_events_delete', {
          params: {
            calendarId: params.calendarId,
            eventId: params.eventId,
            ...(params.sendUpdates ? { sendUpdates: params.sendUpdates } : {}),
          },
        });
      },
    },
    { provenance: 'builtin', source: 'calendar-provider-bridge' }
  );

  registerCalendarProvider(
    {
      provider_id: 'm365',
      readAuthStatus: readM365AuthStatus,
      normalizeEvent: normalizeM365CalendarEvent,
      normalizeEvents: normalizeM365CalendarEvents,
      normalizeCalendarList: normalizeM365CalendarList,
      normalizeFreeBusy: normalizeM365FreeBusy,
      resolveCalendarPath(calendarId) {
        const trimmed = calendarId?.trim();
        if (!trimmed || trimmed === 'primary' || trimmed === 'me') return 'me';
        return `me/calendars/${trimmed}`;
      },
      async listEvents(params) {
        return executeServicePreset('m365', 'calendar_events_list', {
          params: {
            calendarPath: this.resolveCalendarPath(params.calendarId),
            timeMin: params.encodedTimeMin,
            timeMax: params.encodedTimeMax,
            maxResults: params.maxResults,
          },
        });
      },
      async listCalendars() {
        return executeServicePreset('m365', 'calendar_list', { params: {} });
      },
      async queryFreeBusy(params) {
        return executeServicePreset('m365', 'calendar_freebusy_query', {
          body: {
            schedules: params.calendarIds,
            startTime: {
              dateTime: params.timeMin,
              ...(params.timeZone ? { timeZone: params.timeZone } : {}),
            },
            endTime: {
              dateTime: params.timeMax,
              ...(params.timeZone ? { timeZone: params.timeZone } : {}),
            },
            availabilityViewInterval: 30,
          },
        });
      },
      async insertEvent(params) {
        return executeServicePreset('m365', 'calendar_events_insert', {
          params: {
            calendarPath: this.resolveCalendarPath(params.calendarId),
          },
          body: {
            subject: params.summary,
            start: params.start,
            end: params.end,
            ...(params.description
              ? { body: { contentType: 'text', content: params.description } }
              : {}),
            ...(params.location ? { location: { displayName: params.location } } : {}),
            ...(params.attendees?.length
              ? {
                  attendees: params.attendees.map((email) => ({
                    emailAddress: { address: email },
                    type: 'required',
                  })),
                }
              : {}),
            ...(params.withMeet
              ? {
                  isOnlineMeeting: true,
                  onlineMeetingProvider: 'teamsForBusiness',
                }
              : {}),
          },
        });
      },
      async updateEvent(params) {
        return executeServicePreset('m365', 'calendar_events_update', {
          params: {
            calendarPath: this.resolveCalendarPath(params.calendarId),
            eventId: params.eventId,
          },
          body: {
            ...(params.summary !== undefined ? { subject: params.summary } : {}),
            ...(params.description !== undefined
              ? { body: { contentType: 'text', content: params.description } }
              : {}),
            ...(params.location !== undefined
              ? { location: { displayName: params.location } }
              : {}),
            ...(params.start ? { start: params.start } : {}),
            ...(params.end ? { end: params.end } : {}),
            ...(params.attendees
              ? {
                  attendees: params.attendees.map((email) => ({
                    emailAddress: { address: email },
                    type: 'required',
                  })),
                }
              : {}),
            ...(params.reminderMinutesBeforeStart !== undefined
              ? {
                  isReminderOn: true,
                  reminderMinutesBeforeStart: params.reminderMinutesBeforeStart,
                }
              : {}),
          },
        });
      },
      async deleteEvent(params) {
        return executeServicePreset('m365', 'calendar_events_delete', {
          params: {
            calendarPath: this.resolveCalendarPath(params.calendarId),
            eventId: params.eventId,
          },
        });
      },
    },
    { provenance: 'builtin', source: 'calendar-provider-bridge' }
  );

  builtinsRegistered = true;
}

export function normalizeCalendarProviderId(provider?: unknown): CalendarProviderId {
  const id =
    typeof provider === 'string' && provider.trim()
      ? provider.trim().toLowerCase()
      : 'google-workspace';
  return resolveCalendarProvider(id).provider_id;
}

export async function readCalendarProviderAuthStatus(
  provider?: string
): Promise<CalendarProviderAuthStatus> {
  const bridge = resolveCalendarProvider(provider);
  if (bridge.readAuthStatus) return bridge.readAuthStatus();
  return {
    ok: false,
    available: false,
    raw: null,
    error: 'calendar provider does not expose authentication status',
  };
}

export function resolveCalendarProvider(
  provider?: CalendarProviderId | string
): CalendarProviderBridge {
  registerBuiltinCalendarProviders();
  const wanted = String(provider || 'google-workspace')
    .trim()
    .toLowerCase() as CalendarProviderId;
  const bridge = listCalendarProviders().find((entry) => entry.provider_id === wanted);
  if (!bridge) {
    throw new Error(`[calendar-provider] unknown provider '${provider || ''}'`);
  }
  return bridge;
}
