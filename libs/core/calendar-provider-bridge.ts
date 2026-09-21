/**
 * Calendar-provider seam — Google Workspace / M365 calendar backends.
 *
 * calendar-workflow resolves a provider by id; vendor service-preset shapes
 * stay inside the registered adapters.
 */

import { executeServicePreset } from './service-engine.js';
import { coreSeamCatalog, createSeam } from './seam.js';

export type CalendarProviderId = 'google-workspace' | 'm365';

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

export interface CalendarProviderBridge {
  readonly provider_id: CalendarProviderId;
  resolveCalendarPath(calendarId?: string): string;
  listEvents(params: CalendarProviderListEventsParams): Promise<unknown>;
  listCalendars(): Promise<unknown>;
  queryFreeBusy(params: CalendarProviderFreeBusyParams): Promise<unknown>;
  insertEvent(params: CalendarProviderInsertEventParams): Promise<unknown>;
}

const calendarProviderSeam = createSeam<CalendarProviderBridge>({
  key: 'calendar-provider',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

const registeredDisposers = new Map<string, () => void>();
let builtinsRegistered = false;

export function registerCalendarProvider(bridge: CalendarProviderBridge): () => void {
  const id = String(bridge.provider_id || '').trim();
  if (!id) throw new Error('CalendarProviderBridge.provider_id is required');
  registeredDisposers.get(id)?.();
  const disposer = calendarProviderSeam.register(id, bridge, {
    provenance: 'builtin',
    source: 'calendar-provider-bridge',
  });
  registeredDisposers.set(id, disposer);
  return disposer;
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

function registerBuiltinCalendarProviders(): void {
  if (builtinsRegistered) return;

  registerCalendarProvider({
    provider_id: 'google-workspace',
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
  });

  registerCalendarProvider({
    provider_id: 'm365',
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
  });

  builtinsRegistered = true;
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
