import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './calendar-actuator-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'calendar-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'calendar-actuator',
    args: process.argv,
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/calendar-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export {
  handleAction,
  listCalendars,
  listEvents,
  queryFreeBusy,
  createEvent,
} from './calendar-actuator-helpers.js';

export {
  calendarBackendRegistry,
  createCalendarBackend,
  createDefaultCalendarBackendRegistry,
  registerCalendarBackend,
  resolveCalendarBackend,
  selectCalendarBackend,
  CalendarBackendRegistry,
} from './calendar-backend.js';
export type {
  CalendarBackend,
  CalendarBackendAdapter,
  CalendarBackendAvailabilityOverrides,
  CalendarBackendKind,
  CalendarBackendPreference,
  CalendarEvent,
  CalendarEventMutation,
  CalendarFreeBusyEntry,
  CalendarParams,
  CalendarSummary,
  CalendarTarget,
} from './calendar-backend.js';
