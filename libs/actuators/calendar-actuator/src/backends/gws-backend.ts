/** Authenticated Google Workspace backend via the shared calendar workflow. */
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarAgenda,
  listCalendars as listServiceCalendars,
  queryCalendarFreeBusy,
  readGwsAuthStatus,
  updateCalendarEvent,
  type CalendarEventCreateResult,
} from '@agent/core/meeting/calendar-workflow';
import type {
  CalendarBackendAdapter,
  CalendarEvent,
  CalendarEventDeleteResult,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSlotResult,
  CalendarSummary,
} from '../calendar-types.js';
import { calendarName, planSlotsFromBusy } from '../calendar-shared.js';
import {
  forwardCalendarExternalEffect,
  type CalendarMutationKind,
} from '@agent/core/meeting/calendar-external-effect';

function forward<T extends object, R>(
  source: object,
  kind: CalendarMutationKind,
  request: T,
  send: (input: T) => Promise<R>
): Promise<R> {
  return forwardCalendarExternalEffect(source, request, kind, () => send(request));
}

function isGwsReady(): boolean {
  const status = readGwsAuthStatus();
  return Boolean(
    status?.available &&
    (status.auth_method ||
      status.credential_source ||
      status.token_cache_exists ||
      status.encrypted_credentials_exists ||
      status.plain_credentials_exists)
  );
}

export class GwsCalendarBackend implements CalendarBackendAdapter {
  readonly id = 'gws' as const;
  readonly priority = 20;

  isAvailable(): boolean {
    return isGwsReady();
  }

  unavailableMessage(): string {
    return 'calendar-actuator: Google Calendar backend is not authenticated. Run `gws auth setup` and `gws auth login`.';
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const result = await listServiceCalendars('google-workspace');
    return result.calendars.map((calendar) => ({
      name: calendar.summary,
      id: calendar.id,
      time_zone: calendar.time_zone,
    }));
  }

  async listEvents(params: CalendarParams): Promise<CalendarEvent[]> {
    const result = await listCalendarAgenda({
      provider: 'google-workspace',
      calendar_id: calendarName(params),
      query: params.query,
      time_min: params.start_date,
      time_max: params.end_date,
      time_zone: params.time_zone,
    });
    const calendar = calendarName(params) || result.calendar_id;
    return result.events.map((event) => ({
      ...(event.id ? { id: event.id } : {}),
      title: event.summary,
      start: event.start,
      end: event.end,
      calendar,
      location: event.location,
      description: event.description ?? '',
      ...(event.series_id ? { series_id: event.series_id } : {}),
      ...(event.hangout_link ? { meeting_url: event.hangout_link } : {}),
    }));
  }

  async queryFreeBusy(params: CalendarParams): Promise<CalendarFreeBusyEntry[]> {
    const result = await queryCalendarFreeBusy({
      provider: 'google-workspace',
      calendar_id: calendarName(params),
      calendar_ids:
        params.calendar_names || (calendarName(params) ? [calendarName(params)!] : undefined),
      time_min: params.start_date || '',
      time_max: params.end_date || '',
      time_zone: params.time_zone,
    });
    return result.calendars;
  }

  async findSlots(params: CalendarParams): Promise<CalendarSlotResult> {
    return planSlotsFromBusy(params, (selected) => this.queryFreeBusy(selected));
  }

  async createEvent(params: CalendarParams): Promise<CalendarEventMutation> {
    const result: CalendarEventCreateResult = await forward(
      params,
      'create_event',
      {
        provider: 'google-workspace',
        calendar_id: calendarName(params),
        summary: params.title || '',
        start: params.start_date || '',
        end: params.end_date || '',
        description: params.description,
        location: params.location,
        attendees: params.attendees,
        time_zone: params.time_zone,
        with_meet: params.with_meet,
        conference_request_id: params.conference_request_id,
      },
      createCalendarEvent
    );
    return {
      status: result.ok ? 'success' : 'error',
      title: result.created_event.summary,
      id: result.created_event.id,
    };
  }

  async updateEvent(params: CalendarParams): Promise<CalendarEventMutation> {
    const result = await forward(
      params,
      'update_event',
      {
        provider: 'google-workspace',
        calendar_id: calendarName(params),
        event_id: params.event_id || '',
        summary: params.title,
        start: params.start_date,
        end: params.end_date,
        description: params.description,
        location: params.location,
        attendees: params.attendees,
        reminder_minutes_before_start: params.reminder_minutes_before_start,
        send_updates: params.send_updates,
        time_zone: params.time_zone,
      },
      updateCalendarEvent
    );
    return {
      status: result.ok ? 'success' : 'error',
      title: result.created_event.summary,
      id: result.created_event.id,
    };
  }

  async deleteEvent(params: CalendarParams): Promise<CalendarEventDeleteResult> {
    const result = await forward(
      params,
      'delete_event',
      {
        provider: 'google-workspace',
        calendar_id: calendarName(params),
        event_id: params.event_id || '',
        send_updates: params.send_updates,
      },
      deleteCalendarEvent
    );
    return { status: result.ok ? 'success' : 'error', ...result };
  }
}
