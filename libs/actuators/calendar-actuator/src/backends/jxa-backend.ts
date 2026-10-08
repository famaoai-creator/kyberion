/** macOS Calendar.app (JXA) backend. Unavailable off darwin. */
import type {
  CalendarBackendAdapter,
  CalendarEvent,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSlotResult,
  CalendarSummary,
} from '../calendar-types.js';
import {
  calendarName,
  parseISODate,
  planSlotsFromBusy,
  resolveDateRange,
  runJxa,
  normalizeCalendarEventList,
  normalizeCalendarEventMutation,
  normalizeCalendarSummaryList,
} from '../calendar-shared.js';

export class JxaCalendarBackend implements CalendarBackendAdapter {
  readonly id = 'jxa' as const;
  readonly priority = 10;
  readonly capabilities = ['updateEvent:unsupported', 'deleteEvent:unsupported'] as const;

  isAvailable(platform = process.platform): boolean {
    return platform === 'darwin';
  }

  unavailableMessage(): string {
    return 'calendar-actuator: backend "jxa" requires macOS Calendar.app';
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    return runJxa<CalendarSummary[]>(
      `
        const app = Application("Calendar");
        return JSON.stringify(app.calendars().map(function (cal) {
          return { name: cal.name() };
        }));
      `,
      {},
      normalizeCalendarSummaryList
    );
  }

  async listEvents(params: CalendarParams): Promise<CalendarEvent[]> {
    const { start, end } = resolveDateRange(params, 24 * 60 * 60 * 1000);
    return runJxa<CalendarEvent[]>(
      `
        const app = Application("Calendar");
        const targets = PARAMS.calendar_names && PARAMS.calendar_names.length
          ? PARAMS.calendar_names
          : PARAMS.calendar_id
            ? [PARAMS.calendar_id]
          : null;
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
            // Keep the existing best-effort behavior for inaccessible calendars.
          }
        });
        return JSON.stringify(results);
      `,
      {
        calendar_names: params.calendar_names ?? null,
        start_iso: start.toISOString(),
        end_iso: end.toISOString(),
      },
      normalizeCalendarEventList
    );
  }

  async queryFreeBusy(params: CalendarParams): Promise<CalendarFreeBusyEntry[]> {
    const events = await this.listEvents(params);
    const entries = new Map<string, CalendarFreeBusyEntry>();
    const requestedCalendars = params.calendar_names?.map((name) => name.trim()).filter(Boolean);
    for (const name of requestedCalendars?.length ? requestedCalendars : [calendarName(params)]) {
      if (!name) continue;
      entries.set(name, { calendar_id: name, busy: [], errors: [] });
    }
    for (const event of events) {
      const entry = entries.get(event.calendar) || {
        calendar_id: event.calendar,
        busy: [],
        errors: [],
      };
      entry.busy.push({ start: event.start, end: event.end });
      entries.set(event.calendar, entry);
    }
    return [...entries.values()];
  }

  async findSlots(params: CalendarParams): Promise<CalendarSlotResult> {
    return planSlotsFromBusy(params, (selected) => this.queryFreeBusy(selected));
  }

  async createEvent(params: CalendarParams): Promise<CalendarEventMutation> {
    const title = params.title?.trim() || '';
    const calendar = calendarName(params);
    const start = parseISODate(params.start_date, 'start_date');
    const end =
      parseISODate(params.end_date, 'end_date') ||
      (start ? new Date(start.getTime() + 30 * 60 * 1000) : null);
    if (!title || !calendar || !start || !end) {
      throw new Error(
        'calendar-actuator: create_event requires title, start_date, and calendar_names[0]'
      );
    }
    if (end.getTime() <= start.getTime()) {
      throw new Error(
        `calendar-actuator: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`
      );
    }

    return runJxa<CalendarEventMutation>(
      `
        const app = Application("Calendar");
        const cal = app.calendars.byName(PARAMS.calendar_name);
        if (!cal.exists()) {
          return JSON.stringify({ status: "error", error: "calendar_not_found", title: PARAMS.title });
        }
        const event = app.Event({
          summary: PARAMS.title,
          startDate: new Date(PARAMS.start_iso),
          endDate: new Date(PARAMS.end_iso),
          location: PARAMS.location || "",
          description: PARAMS.description || ""
        });
        cal.events.push(event);
        return JSON.stringify({ status: "success", title: PARAMS.title });
      `,
      {
        calendar_name: calendar,
        title,
        start_iso: start.toISOString(),
        end_iso: end.toISOString(),
        location: params.location?.trim() || '',
        description: params.description?.trim() || '',
      },
      normalizeCalendarEventMutation
    );
  }
}
