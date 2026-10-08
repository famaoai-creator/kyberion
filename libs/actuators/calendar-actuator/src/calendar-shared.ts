/**
 * Shared calendar backend primitives: JXA execution, date-range
 * handling, slot planning, and response normalization.
 * Backend classes (JXA / GWS) build on these; no registry here.
 */

import { retry, getRetryDefaults } from '@agent/core/async-utils';
import { safeExec } from '@agent/core/secure-io';
import { parseSafeJsonInput } from '@agent/core/foundation';
import { isRecord } from '@agent/core/foundation/text';
import * as pathResolver from '@agent/core/path-resolver';
import { planAvailableSlots, type AvailableSlot } from '@agent/core/meeting/calendar-slot-planner';
import { defineActuatorPipelineBase } from '@agent/core/actuator/actuator-sdk';
import type {
  CalendarEvent,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSlotResult,
  CalendarSummary,
} from './calendar-types.js';

export type {
  CalendarEvent,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSlotResult,
  CalendarSummary,
} from './calendar-types.js';

const CALENDAR_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/calendar-actuator/manifest.json'
);
const DEFAULT_CALENDAR_RETRY = getRetryDefaults('calendar');

const { buildRetryOptions } = defineActuatorPipelineBase({
  manifestPath: CALENDAR_MANIFEST_PATH,
  retryDefaults: DEFAULT_CALENDAR_RETRY,
  retryFallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

export { buildRetryOptions };

export function parseISODate(value: string | undefined, label: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`calendar-actuator: invalid ${label}: "${value}"`);
  }
  return date;
}

export function resolveDateRange(
  params: CalendarParams,
  defaultDurationMs: number
): { start: Date; end: Date } {
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

export function normalizeCalendarSummaryList(value: unknown): CalendarSummary[] {
  if (!Array.isArray(value)) {
    throw new Error('calendar-actuator: osascript calendars response must be an array');
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string') {
      throw new Error(`calendar-actuator: invalid calendar summary at index ${index}`);
    }
    return {
      name: entry.name,
      ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
      ...(typeof entry.time_zone === 'string' ? { time_zone: entry.time_zone } : {}),
    };
  });
}

export function normalizeCalendarEventList(value: unknown): CalendarEvent[] {
  if (!Array.isArray(value)) {
    throw new Error('calendar-actuator: osascript events response must be an array');
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.title !== 'string' ||
      typeof entry.start !== 'string' ||
      typeof entry.end !== 'string' ||
      typeof entry.calendar !== 'string' ||
      typeof entry.location !== 'string' ||
      typeof entry.description !== 'string'
    ) {
      throw new Error(`calendar-actuator: invalid calendar event at index ${index}`);
    }
    return {
      ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
      title: entry.title,
      start: entry.start,
      end: entry.end,
      calendar: entry.calendar,
      location: entry.location,
      description: entry.description,
    };
  });
}

export function normalizeCalendarEventMutation(value: unknown): CalendarEventMutation {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    typeof value.title !== 'string' ||
    (value.id !== undefined && typeof value.id !== 'string') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) {
    throw new Error('calendar-actuator: invalid osascript event mutation response');
  }
  return {
    status: value.status,
    title: value.title,
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export async function runJxa<T>(
  scriptBody: string,
  params: Record<string, unknown>,
  normalize: (value: unknown) => T
): Promise<T> {
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
  try {
    return normalize(
      trimmed ? parseSafeJsonInput(trimmed, 'calendar osascript response') : undefined
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`calendar-actuator: failed to parse osascript output: ${message}`);
  }
}

export function calendarName(params: CalendarParams): string | undefined {
  return (
    params.calendar_names?.map((name) => name.trim()).find(Boolean) ||
    params.calendar_id?.trim() ||
    undefined
  );
}

export async function planSlotsFromBusy(
  params: CalendarParams,
  query: (params: CalendarParams) => Promise<CalendarFreeBusyEntry[]>
): Promise<CalendarSlotResult> {
  const busy = (await query(params)).flatMap((entry) => entry.busy);
  return {
    slots: planAvailableSlots({
      range_start: params.start_date || '',
      range_end: params.end_date || '',
      duration_minutes: params.duration_minutes || 0,
      ...(params.slot_step_minutes ? { slot_step_minutes: params.slot_step_minutes } : {}),
      ...(params.time_zone ? { timezone: params.time_zone } : {}),
      ...(params.business_calendar ? { business_calendar: params.business_calendar } : {}),
      ...(params.working_hours ? { working_hours: params.working_hours } : {}),
      busy,
    }),
  };
}

export type { AvailableSlot };
