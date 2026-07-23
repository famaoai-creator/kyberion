import { buildGovernedRetryOptions, pathResolver, retry, safeExec } from '@agent/core';
import {
  createCalendarEvent,
  listCalendarAgenda,
  listCalendars as listServiceCalendars,
  queryCalendarFreeBusy,
  readGwsAuthStatus,
  type CalendarEventCreateResult,
} from '@agent/core/calendar-workflow';

export type CalendarBackendKind = string;
export type CalendarBackendPreference = string;

export interface CalendarTarget {
  backend?: string;
  calendar_id?: string;
  calendar_name?: string;
}

export interface CalendarParams {
  attendees?: string[];
  backend?: CalendarBackendPreference;
  backends?: string[];
  calendar_id?: string;
  calendar_names?: string[];
  calendar_targets?: CalendarTarget[];
  conference_request_id?: string;
  description?: string;
  end_date?: string;
  location?: string;
  query?: string;
  start_date?: string;
  time_zone?: string;
  title?: string;
  with_meet?: boolean;
}

export interface CalendarEvent {
  backend?: string;
  title: string;
  start: string;
  end: string;
  calendar: string;
  location: string;
  description: string;
}

export interface CalendarSummary {
  backend?: string;
  name: string;
  id?: string;
  time_zone?: string;
}

export interface CalendarFreeBusyEntry {
  backend?: string;
  calendar_id: string;
  busy: Array<{ start: string; end: string }>;
  errors: string[];
}

export interface CalendarEventMutation {
  backend?: string;
  status: string;
  title: string;
  id?: string;
  error?: string;
}

export interface CalendarBackendAdapter {
  readonly id: CalendarBackendKind;
  readonly priority?: number;
  isAvailable(platform?: string): boolean;
  unavailableMessage(): string;
  listCalendars(params?: CalendarParams): Promise<CalendarSummary[]>;
  listEvents(params: CalendarParams): Promise<CalendarEvent[]>;
  queryFreeBusy(params: CalendarParams): Promise<CalendarFreeBusyEntry[]>;
  createEvent(params: CalendarParams): Promise<CalendarEventMutation>;
}

export type CalendarBackend = CalendarBackendAdapter;

const CALENDAR_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/calendar-actuator/manifest.json'
);
const DEFAULT_CALENDAR_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

function parseISODate(value: string | undefined, label: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`calendar-actuator: invalid ${label}: "${value}"`);
  }
  return date;
}

function resolveDateRange(
  params: CalendarParams,
  defaultDurationMs: number
): {
  start: Date;
  end: Date;
} {
  const startInput = parseISODate(params.start_date, 'start_date');
  const endInput = parseISODate(params.end_date, 'end_date');
  const start = startInput ?? new Date();
  if (!startInput) start.setHours(0, 0, 0, 0);
  const end = endInput ?? new Date(start.getTime() + defaultDurationMs);
  if (!endInput && defaultDurationMs >= 24 * 60 * 60 * 1000) {
    end.setHours(23, 59, 59, 999);
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error(
      `calendar-actuator: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`
    );
  }
  return { start, end };
}

function buildRetryOptions() {
  return buildGovernedRetryOptions({
    manifestPath: CALENDAR_MANIFEST_PATH,
    defaults: DEFAULT_CALENDAR_RETRY,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

async function runJxa<T>(scriptBody: string, params: Record<string, unknown>): Promise<T> {
  const paramsLiteral = JSON.stringify(JSON.stringify(params));
  const script = `
    (function() {
      const PARAMS = JSON.parse(${paramsLiteral});
      ${scriptBody}
    })();
  `;
  const output = await retry(
    async () => safeExec('osascript', ['-l', 'JavaScript', '-e', script]),
    buildRetryOptions()
  );
  const trimmed = String(output).trim();
  if (!trimmed) return undefined as unknown as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`calendar-actuator: failed to parse osascript output: ${message}`);
  }
}

function calendarName(params: CalendarParams): string | undefined {
  return (
    params.calendar_names?.map((name) => name.trim()).find(Boolean) ||
    params.calendar_id?.trim() ||
    undefined
  );
}

class JxaCalendarBackend implements CalendarBackend {
  readonly id = 'jxa' as const;
  readonly priority = 10;

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
      {}
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
      }
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
      }
    );
  }
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

class GwsCalendarBackend implements CalendarBackend {
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
      title: event.summary,
      start: event.start,
      end: event.end,
      calendar,
      location: event.location,
      description: '',
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

  async createEvent(params: CalendarParams): Promise<CalendarEventMutation> {
    const result: CalendarEventCreateResult = await createCalendarEvent({
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
    });
    return {
      status: result.ok ? 'success' : 'error',
      title: result.created_event.summary,
      id: result.created_event.id,
    };
  }
}

export interface CalendarBackendAvailabilityOverrides {
  [backendId: string]: boolean | undefined;
}

export class CalendarBackendRegistry {
  private readonly adapters = new Map<string, CalendarBackendAdapter>();

  constructor(adapters: readonly CalendarBackendAdapter[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register(adapter: CalendarBackendAdapter): this {
    const id = adapter.id.trim();
    if (!id) throw new Error('calendar-actuator: backend adapter id is required');
    if (this.adapters.has(id)) {
      throw new Error(`calendar-actuator: backend adapter "${id}" is already registered`);
    }
    this.adapters.set(id, adapter);
    return this;
  }

  get(id: string): CalendarBackendAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(
        `calendar-actuator: unsupported backend "${id}". Available backends: ${this.ids().join(', ') || '(none)'}`
      );
    }
    return adapter;
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  resolve(
    requested: CalendarBackendPreference = 'auto',
    platform: string = process.platform,
    availabilityOverrides: CalendarBackendAvailabilityOverrides = {}
  ): CalendarBackendAdapter {
    if (requested !== 'auto') {
      const adapter = this.get(requested);
      if (!this.isAvailable(adapter, platform, availabilityOverrides)) {
        throw new Error(adapter.unavailableMessage());
      }
      return adapter;
    }

    const available = [...this.adapters.values()]
      .filter((adapter) => this.isAvailable(adapter, platform, availabilityOverrides))
      .sort((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
    if (available[0]) return available[0];
    throw new Error(
      `calendar-actuator: no calendar backend is ready. ${[...this.adapters.values()]
        .map((adapter) => adapter.unavailableMessage())
        .join(' ')} Available backends: ${this.ids().join(', ') || '(none)'}`
    );
  }

  private isAvailable(
    adapter: CalendarBackendAdapter,
    platform: string,
    availabilityOverrides: CalendarBackendAvailabilityOverrides
  ): boolean {
    const override = availabilityOverrides[adapter.id];
    return override === undefined ? adapter.isAvailable(platform) : override;
  }
}

export function createDefaultCalendarBackendRegistry(): CalendarBackendRegistry {
  return new CalendarBackendRegistry([new JxaCalendarBackend(), new GwsCalendarBackend()]);
}

export const calendarBackendRegistry = createDefaultCalendarBackendRegistry();

export function registerCalendarBackend(adapter: CalendarBackendAdapter): CalendarBackendRegistry {
  calendarBackendRegistry.register(adapter);
  return calendarBackendRegistry;
}

export function selectCalendarBackend(
  requested: CalendarBackendPreference = 'auto',
  platform: string = process.platform,
  availabilityOverrides: CalendarBackendAvailabilityOverrides = {}
): CalendarBackendKind {
  return calendarBackendRegistry.resolve(requested, platform, availabilityOverrides).id;
}

export function createCalendarBackend(
  kind: CalendarBackendKind,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): CalendarBackend {
  return registry.get(kind);
}

export function resolveCalendarBackend(
  requested: CalendarBackendPreference = 'auto',
  registry: CalendarBackendRegistry = calendarBackendRegistry
): CalendarBackend {
  return registry.resolve(requested);
}

export function createJxaCalendarBackend(): CalendarBackend {
  return calendarBackendRegistry.get('jxa');
}
