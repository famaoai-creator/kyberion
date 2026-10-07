/**
 * Calendar actuator shared types.
 *
 * Single source for backend contracts so JXA / GWS / third-party
 * adapters and the dispatch layer share one shape. No IO here.
 */

import type { AvailableSlot } from '@agent/core/meeting/calendar-slot-planner';

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
  event_id?: string;
  reminder_minutes_before_start?: number;
  send_updates?: 'all' | 'externalOnly' | 'none';
  duration_minutes?: number;
  slot_step_minutes?: number;
  business_calendar?: 'none' | 'japanese_bank';
  working_hours?: { start: string; end: string; weekdays?: number[] };
}

export interface CalendarEvent {
  id?: string;
  backend?: string;
  title: string;
  start: string;
  end: string;
  calendar: string;
  location: string;
  description: string;
}

export interface CalendarSlotResult {
  backend?: string;
  slots: AvailableSlot[];
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

export interface CalendarEventDeleteResult {
  backend?: string;
  status: string;
  event_id: string;
  calendar_id: string;
}

/**
 * Backend adapter contract. `updateEvent` / `deleteEvent` / `findSlots`
 * are optional capabilities: dispatch probes them and reports a
 * capability error instead of NoSuchMethod.
 */
export interface CalendarBackendAdapter {
  readonly id: CalendarBackendKind;
  readonly priority?: number;
  /** Human-readable capability list for discovery / help output. */
  readonly capabilities?: readonly string[];
  isAvailable(platform?: string): boolean;
  unavailableMessage(): string;
  listCalendars(params?: CalendarParams): Promise<CalendarSummary[]>;
  listEvents(params: CalendarParams): Promise<CalendarEvent[]>;
  queryFreeBusy(params: CalendarParams): Promise<CalendarFreeBusyEntry[]>;
  createEvent(params: CalendarParams): Promise<CalendarEventMutation>;
  updateEvent?(params: CalendarParams): Promise<CalendarEventMutation>;
  deleteEvent?(params: CalendarParams): Promise<CalendarEventDeleteResult>;
  findSlots?(params: CalendarParams): Promise<CalendarSlotResult>;
}

export type CalendarBackend = CalendarBackendAdapter;

export interface CalendarBackendAvailabilityOverrides {
  [backendId: string]: boolean | undefined;
}
