/**
 * Compatibility facade — the implementation now lives in
 * calendar-types / calendar-shared / calendar-registry / backends/*.
 * This module re-exports the public surface so existing imports keep working.
 */
import { JxaCalendarBackend } from './backends/jxa-backend.js';
import { GwsCalendarBackend } from './backends/gws-backend.js';
import { CalendarBackendRegistry } from './calendar-registry.js';

export type {
  CalendarBackend,
  CalendarBackendAdapter,
  CalendarBackendAvailabilityOverrides,
  CalendarBackendKind,
  CalendarBackendPreference,
  CalendarEvent,
  CalendarEventDeleteResult,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSlotResult,
  CalendarSummary,
  CalendarTarget,
} from './calendar-types.js';
export { CalendarBackendRegistry } from './calendar-registry.js';
export {
  normalizeCalendarEventList,
  normalizeCalendarEventMutation,
  normalizeCalendarSummaryList,
} from './calendar-shared.js';

export function createDefaultCalendarBackendRegistry(): CalendarBackendRegistry {
  return new CalendarBackendRegistry([new JxaCalendarBackend(), new GwsCalendarBackend()]);
}

export const calendarBackendRegistry = createDefaultCalendarBackendRegistry();

export function registerCalendarBackend(
  adapter: import('./calendar-types.js').CalendarBackendAdapter
): CalendarBackendRegistry {
  calendarBackendRegistry.register(adapter);
  return calendarBackendRegistry;
}

export function selectCalendarBackend(
  requested: import('./calendar-types.js').CalendarBackendPreference = 'auto',
  platform: string = process.platform,
  availabilityOverrides: import('./calendar-types.js').CalendarBackendAvailabilityOverrides = {}
): import('./calendar-types.js').CalendarBackendKind {
  return calendarBackendRegistry.resolve(requested, platform, availabilityOverrides).id;
}

export function createCalendarBackend(
  kind: import('./calendar-types.js').CalendarBackendKind,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): import('./calendar-types.js').CalendarBackend {
  return registry.get(kind);
}

export function resolveCalendarBackend(
  requested: import('./calendar-types.js').CalendarBackendPreference = 'auto',
  registry: CalendarBackendRegistry = calendarBackendRegistry
): import('./calendar-types.js').CalendarBackend {
  return registry.resolve(requested);
}

export function createJxaCalendarBackend(): import('./calendar-types.js').CalendarBackend {
  return calendarBackendRegistry.get('jxa');
}
