import { classifyError } from '@agent/core/error-classifier';
import { compileSchemaFromPath } from '@agent/core/schema-loader';
import * as pathResolver from '@agent/core/path-resolver';
import { persistTrace, TraceContext } from '@agent/core/trace';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { createAjv } from '@agent/core/foundation';
import type { ValidateFunction } from 'ajv';
import {
  calendarBackendRegistry,
  createJxaCalendarBackend,
  type CalendarBackendRegistry,
  type CalendarBackendAdapter,
  type CalendarEvent,
  type CalendarEventDeleteResult,
  type CalendarEventMutation,
  type CalendarFreeBusyEntry,
  type CalendarSlotResult,
  type CalendarSummary,
  type CalendarTarget,
  type CalendarParams,
} from './calendar-backend.js';

export type CalendarAction = {
  op:
    | 'list_calendars'
    | 'list_events'
    | 'query_freebusy'
    | 'find_slots'
    | 'create_event'
    | 'update_event'
    | 'delete_event';
  params?: CalendarParams;
};

const CALENDAR_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/calendar-action.schema.json'
);

let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = createAjv();
  cachedValidator = compileSchemaFromPath(ajv, CALENDAR_SCHEMA_PATH);
  return cachedValidator;
}

function missingRequiredFields(action: CalendarAction): string[] {
  const params = action.params || {};
  if (action.op === 'create_event') {
    const missing: string[] = [];
    if (!params.title?.trim()) missing.push('params.title (例: "歯医者")');
    if (!params.start_date?.trim()) {
      missing.push('params.start_date (例: "2026-07-25T10:00:00+09:00")');
    }
    if (!(
      params.calendar_names?.some((name) => name.trim()) ||
      params.calendar_id?.trim() ||
      params.calendar_targets?.some(
        (target) => target.calendar_id?.trim() || target.calendar_name?.trim()
      )
    )) {
      missing.push(
        // i18n-exempt: JA usage example in error text
        'params.calendar_names[0]、params.calendar_id、または params.calendar_targets[0] (例: "primary")'
      );
    }
    return missing;
  }
  if (action.op === 'query_freebusy') {
    const missing: string[] = [];
    if (!params.start_date?.trim()) {
      missing.push('params.start_date (例: "2026-07-25T09:00:00+09:00")');
    }
    if (!params.end_date?.trim()) {
      missing.push('params.end_date (例: "2026-07-25T18:00:00+09:00")');
    }
    return missing;
  }
  if (action.op === 'find_slots') {
    const missing: string[] = [];
    if (!params.start_date?.trim()) missing.push('params.start_date');
    if (!params.end_date?.trim()) missing.push('params.end_date');
    if (!Number.isInteger(params.duration_minutes) || Number(params.duration_minutes) < 1) {
      missing.push('params.duration_minutes');
    }
    return missing;
  }
  if (action.op === 'update_event' || action.op === 'delete_event') {
    const missing: string[] = [];
    if (!params.event_id?.trim()) missing.push('params.event_id');
    if (!params.calendar_id?.trim() && !params.calendar_names?.some((name) => name.trim())) {
      missing.push('params.calendar_id or params.calendar_names[0]');
    }
    if (
      action.op === 'update_event' &&
      params.reminder_minutes_before_start !== undefined &&
      (!Number.isInteger(params.reminder_minutes_before_start) ||
        params.reminder_minutes_before_start < 0)
    ) {
      missing.push('params.reminder_minutes_before_start (non-negative integer)');
    }
    if (
      action.op === 'update_event' &&
      params.title === undefined &&
      params.start_date === undefined &&
      params.end_date === undefined &&
      params.description === undefined &&
      params.location === undefined &&
      params.attendees === undefined &&
      params.reminder_minutes_before_start === undefined
    ) {
      missing.push('one event field to update');
    }
    return missing;
  }
  return [];
}

function validateAction(input: unknown): CalendarAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`calendar-actuator: invalid input: ${errors}`);
  }
  const action = input as CalendarAction;
  const missing = missingRequiredFields(action);
  if (missing.length) {
    throw new Error(`calendar-actuator: missing required fields: ${missing.join(', ')}`);
  }
  return action;
}

type CalendarBackendSelection = {
  adapter: CalendarBackendAdapter;
  params: CalendarParams;
};

function targetParams(params: CalendarParams, target: CalendarTarget): CalendarParams {
  return {
    ...params,
    backend: target.backend || params.backend,
    backends: undefined,
    calendar_id: target.calendar_id || undefined,
    calendar_names: target.calendar_name ? [target.calendar_name] : undefined,
    calendar_targets: undefined,
  };
}

function resolveSelections(
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): CalendarBackendSelection[] {
  if (params.calendar_targets?.length) {
    return params.calendar_targets.map((target) => ({
      adapter: registry.resolve(target.backend || params.backend || 'auto'),
      params: targetParams(params, target),
    }));
  }

  const requested = params.backends?.length
    ? params.backends
    : params.backend && params.backend !== 'auto'
      ? [params.backend]
      : ['auto'];
  return requested.map((backend) => ({
    adapter: registry.resolve(backend),
    params: { ...params, backends: undefined, calendar_targets: undefined },
  }));
}

function annotate<T extends object>(
  adapter: CalendarBackendAdapter,
  value: T
): T & { backend: string } {
  return { ...value, backend: adapter.id };
}

function uniqueSelections(selections: CalendarBackendSelection[]): CalendarBackendSelection[] {
  const seen = new Set<string>();
  return selections.filter(({ adapter }) => {
    if (seen.has(adapter.id)) return false;
    seen.add(adapter.id);
    return true;
  });
}

export async function handleAction(
  action: CalendarAction,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<unknown> {
  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `calendar:${action.op}`,
    params: (action.params || {}) as Record<string, unknown>,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation calendar:${action.op} was not admitted.`}`
    );
  }
  const valid = validateAction({
    ...action,
    params: preflight.input as CalendarAction['params'],
  });
  const params = valid.params || {};
  const selections =
    valid.op === 'list_calendars'
      ? uniqueSelections(resolveSelections(params, registry))
      : resolveSelections(params, registry);
  if (
    ['create_event', 'update_event', 'delete_event'].includes(valid.op) &&
    selections.length !== 1
  ) {
    throw new Error(
      'calendar-actuator: create_event requires exactly one backend/calendar target; use calendar_targets with one entry'
    );
  }
  const backends = selections.map(({ adapter }) => adapter.id);
  const traceCtx = new TraceContext(`calendar-actuator:${valid.op}`, {
    actuator: 'calendar-actuator',
  });
  traceCtx.addEvent('action.received', { op: valid.op, backend: backends.join(',') });
  let result: unknown;
  try {
    switch (valid.op) {
      case 'list_calendars': {
        const values = await Promise.all(
          selections.map(async ({ adapter, params: selectedParams }) =>
            (await adapter.listCalendars(selectedParams)).map((calendar) =>
              annotate(adapter, calendar)
            )
          )
        );
        result = values.flat();
        break;
      }
      case 'list_events': {
        const values = await Promise.all(
          selections.map(async ({ adapter, params: selectedParams }) =>
            (await adapter.listEvents(selectedParams)).map((event) => annotate(adapter, event))
          )
        );
        result = values.flat();
        break;
      }
      case 'query_freebusy': {
        const values = await Promise.all(
          selections.map(async ({ adapter, params: selectedParams }) =>
            (await adapter.queryFreeBusy(selectedParams)).map((entry) => annotate(adapter, entry))
          )
        );
        result = values.flat();
        break;
      }
      case 'find_slots': {
        const values = await Promise.all(
          selections.map(async ({ adapter, params: selectedParams }) => {
            if (!adapter.findSlots) {
              throw new Error(
                `calendar-actuator: backend '${adapter.id}' does not provide the temporal slot capability`
              );
            }
            return annotate(adapter, await adapter.findSlots(selectedParams));
          })
        );
        result = values;
        break;
      }
      case 'create_event': {
        const [{ adapter, params: selectedParams }] = selections;
        result = annotate(adapter, await adapter.createEvent(selectedParams));
        break;
      }
      case 'update_event': {
        const [{ adapter, params: selectedParams }] = selections;
        if (!adapter.updateEvent) {
          throw new Error(
            `calendar-actuator: backend '${adapter.id}' does not provide the event update capability`
          );
        }
        result = annotate(adapter, await adapter.updateEvent(selectedParams));
        break;
      }
      case 'delete_event': {
        const [{ adapter, params: selectedParams }] = selections;
        if (!adapter.deleteEvent) {
          throw new Error(
            `calendar-actuator: backend '${adapter.id}' does not provide the event delete capability`
          );
        }
        result = annotate(adapter, await adapter.deleteEvent(selectedParams));
        break;
      }
      default: {
        const _exhaustive: never = valid.op;
        throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
      }
    }
    traceCtx.addEvent('action.completed', {
      op: valid.op,
      backend: backends.join(','),
      records: Array.isArray(result) ? result.length : 1,
    });
    return result;
  } catch (error: unknown) {
    const classified = classifyError(error);
    traceCtx.addEvent('action.failed', {
      op: valid.op,
      backend: backends.join(','),
      category: classified.category,
    });
    throw error;
  } finally {
    try {
      persistTrace(traceCtx.finalize());
    } catch (_) {
      // Trace persistence is best-effort and must not change the action result.
    }
  }
}

// Typed client facade — registry-backed by default so callers get the
// selected backend (auto / explicit) without touching dispatch envelopes.
// `*OnJxa` variants preserve the historical macOS-direct surface.
const jxaBackend = createJxaCalendarBackend();

function backendFor(
  params: CalendarParams,
  registry: CalendarBackendRegistry
): CalendarBackendAdapter {
  return registry.resolve(params.backend || 'auto');
}

export const listCalendars = (
  params: CalendarParams = {},
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarSummary[]> => backendFor(params, registry).listCalendars(params);
export const listEvents = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarEvent[]> => backendFor(params, registry).listEvents(params);
export const queryFreeBusy = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarFreeBusyEntry[]> => backendFor(params, registry).queryFreeBusy(params);
export const findSlots = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarSlotResult> => {
  const adapter = backendFor(params, registry);
  if (!adapter.findSlots) {
    throw new Error(
      `calendar-actuator: backend '${adapter.id}' does not provide the temporal slot capability`
    );
  }
  return adapter.findSlots(params);
};
export const createEvent = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarEventMutation> => backendFor(params, registry).createEvent(params);
export const updateEvent = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarEventMutation> => {
  const adapter = backendFor(params, registry);
  if (!adapter.updateEvent) {
    throw new Error(
      `calendar-actuator: backend '${adapter.id}' does not provide the event update capability`
    );
  }
  return adapter.updateEvent(params);
};
export const deleteEvent = (
  params: CalendarParams,
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<CalendarEventDeleteResult> => {
  const adapter = backendFor(params, registry);
  if (!adapter.deleteEvent) {
    throw new Error(
      `calendar-actuator: backend '${adapter.id}' does not provide the event delete capability`
    );
  }
  return adapter.deleteEvent(params);
};

/** Backend ids in registration order. */
export const listBackends = (
  registry: CalendarBackendRegistry = calendarBackendRegistry
): string[] => registry.ids();

/** Capability summary for help / discovery output. */
export const describeBackendCapabilities = (
  registry: CalendarBackendRegistry = calendarBackendRegistry
): ReturnType<CalendarBackendRegistry['describeCapabilities']> => registry.describeCapabilities();

/**
 * Composite: pick the first free slot for the requested duration and
 * create the event there. Returns the chosen slot alongside the
 * backend mutation so pipelines need one call instead of two.
 */
export async function scheduleInFirstSlot(
  params: CalendarParams & { duration_minutes: number },
  registry: CalendarBackendRegistry = calendarBackendRegistry
): Promise<{ slot: CalendarSlotResult['slots'][number]; event: CalendarEventMutation }> {
  const slots = await findSlots(params, registry);
  const slot = slots.slots[0];
  if (!slot) throw new Error('calendar-actuator: no free slot in the requested window');
  const event = await createEvent(
    { ...params, start_date: slot.start, end_date: slot.end },
    registry
  );
  return { slot, event };
}

// Explicit macOS-direct surface for callers that need JXA semantics.
export const listCalendarsOnJxa = (): ReturnType<typeof jxaBackend.listCalendars> =>
  jxaBackend.listCalendars();
export const listEventsOnJxa = (params: CalendarParams): ReturnType<typeof jxaBackend.listEvents> =>
  jxaBackend.listEvents(params);
