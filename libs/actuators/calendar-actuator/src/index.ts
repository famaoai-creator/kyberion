import {
  logger,
  safeExec,
  safeReadFile,
  createStandardYargs,
  pathResolver,
  TraceContext,
  persistTrace,
  withRetry,
  classifyError,
  formatClassification,
  compileSchemaFromPath,
} from '@agent/core';
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import * as path from 'node:path';

interface CalendarParams {
  calendar_names?: string[];
  start_date?: string;
  end_date?: string;
  title?: string;
  location?: string;
  description?: string;
}

interface CalendarAction {
  op: 'list_calendars' | 'list_events' | 'create_event';
  params?: CalendarParams;
}

interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  calendar: string;
  location: string;
  description: string;
}

interface CalendarSummary {
  name: string;
}

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const CALENDAR_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/calendar-actuator/manifest.json');
const DEFAULT_CALENDAR_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
  jitter: true,
};

let cachedValidator: ValidateFunction | null = null;
let cachedRecoveryPolicy: Record<string, any> | null = null;
function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const ajv = new AjvCtor({ allErrors: true });
  addFormats(ajv);
  const schemaPath = path.resolve(
    pathResolver.rootDir(),
    'libs/actuators/calendar-actuator/schemas/calendar-action.schema.json',
  );
  cachedValidator = compileSchemaFromPath(ajv, schemaPath);
  return cachedValidator;
}

function validateAction(input: unknown): CalendarAction {
  const validate = getValidator();
  if (!validate(input)) {
    const errors = (validate.errors || [])
      .map(e => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
      .join('; ');
    throw new Error(`calendar-actuator: invalid input: ${errors}`);
  }
  return input as CalendarAction;
}

function parseISODate(value: string | undefined, label: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`calendar-actuator: invalid ${label}: "${value}"`);
  }
  return d;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function loadRecoveryPolicy(): Record<string, any> {
  if (cachedRecoveryPolicy) return cachedRecoveryPolicy;
  try {
    const manifest = JSON.parse(safeReadFile(CALENDAR_MANIFEST_PATH, { encoding: 'utf8' }) as string);
    cachedRecoveryPolicy = isPlainObject(manifest?.recovery_policy) ? manifest.recovery_policy : {};
    return cachedRecoveryPolicy;
  } catch (_) {
    cachedRecoveryPolicy = {};
    return cachedRecoveryPolicy;
  }
}

function buildRetryOptions(override?: Record<string, any>) {
  const recoveryPolicy = loadRecoveryPolicy();
  const manifestRetry = isPlainObject(recoveryPolicy.retry) ? recoveryPolicy.retry : {};
  const retryableCategories = new Set<string>(
    Array.isArray(recoveryPolicy.retryable_categories) ? recoveryPolicy.retryable_categories.map(String) : [],
  );
  const resolved = {
    ...DEFAULT_CALENDAR_RETRY,
    ...manifestRetry,
    ...(override || {}),
  };
  return {
    ...resolved,
    shouldRetry: (error: Error) => {
      const classification = classifyError(error);
      if (retryableCategories.size > 0) {
        return retryableCategories.has(classification.category);
      }
      return classification.category === 'network'
        || classification.category === 'rate_limit'
        || classification.category === 'timeout'
        || classification.category === 'resource_unavailable';
    },
  };
}

/**
 * Run a JXA script that reads its parameters from a JSON literal embedded in
 * the script body. The double-JSON.stringify pattern prevents any user-supplied
 * value (title, location, calendar names, etc.) from being interpreted as JXA
 * code — they always land as plain string properties on the parsed object.
 *
 * Without this, string interpolation like `summary: "${params.title}"` would
 * allow a user with quotes in an event title to break out of the string
 * literal and execute arbitrary JXA.
 */
async function runJxa<T>(scriptBody: string, params: Record<string, unknown>): Promise<T> {
  const paramsLiteral = JSON.stringify(JSON.stringify(params));
  const script = `
    (function() {
      const PARAMS = JSON.parse(${paramsLiteral});
      ${scriptBody}
    })();
  `;
  const output = await withRetry(async () => safeExec('osascript', ['-l', 'JavaScript', '-e', script]), buildRetryOptions());
  const trimmed = String(output).trim();
  if (!trimmed) return undefined as unknown as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err: any) {
    throw new Error(
      `calendar-actuator: failed to parse osascript output: ${err.message}\n${trimmed.slice(0, 300)}`,
    );
  }
}

export async function listCalendars(): Promise<CalendarSummary[]> {
  return runJxa<CalendarSummary[]>(
    `
      const app = Application("Calendar");
      return JSON.stringify(app.calendars().map(function (cal) { return { name: cal.name() }; }));
    `,
    {},
  );
}

export async function listEvents(params: CalendarParams): Promise<CalendarEvent[]> {
  const startInput = parseISODate(params.start_date, 'start_date');
  const endInput = parseISODate(params.end_date, 'end_date');

  const start = startInput ?? new Date();
  if (!startInput) start.setHours(0, 0, 0, 0);
  const end = endInput ?? new Date(start.getTime() + 24 * 60 * 60 * 1000);
  if (!endInput) end.setHours(23, 59, 59, 999);

  if (end.getTime() <= start.getTime()) {
    throw new Error(
      `calendar-actuator: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`,
    );
  }

  return runJxa<CalendarEvent[]>(
    `
      const app = Application("Calendar");
      const targets = PARAMS.calendar_names && PARAMS.calendar_names.length ? PARAMS.calendar_names : null;
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
          // Silently skip calendars that fail to query (permission / corrupted state).
        }
      });
      return JSON.stringify(results);
    `,
    {
      calendar_names: params.calendar_names ?? null,
      start_iso: start.toISOString(),
      end_iso: end.toISOString(),
    },
  );
}

export async function createEvent(params: CalendarParams): Promise<{ status: string; title: string }> {
  if (!params.title || !params.start_date || !params.calendar_names?.[0]) {
    throw new Error(
      'calendar-actuator: create_event requires title, start_date, and calendar_names[0]',
    );
  }
  const start = parseISODate(params.start_date, 'start_date')!;
  const end =
    parseISODate(params.end_date, 'end_date') ??
    new Date(start.getTime() + 30 * 60 * 1000);
  if (end.getTime() <= start.getTime()) {
    throw new Error(
      `calendar-actuator: end_date (${end.toISOString()}) must be after start_date (${start.toISOString()})`,
    );
  }

  return runJxa<{ status: string; title: string }>(
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
      calendar_name: params.calendar_names[0],
      title: params.title,
      start_iso: start.toISOString(),
      end_iso: end.toISOString(),
      location: params.location ?? '',
      description: params.description ?? '',
    },
  );
}

export async function handleAction(action: CalendarAction): Promise<unknown> {
  const valid = validateAction(action);
  const traceCtx = new TraceContext(`calendar-actuator:${valid.op}`, {
    actuator: 'calendar-actuator',
  });
  traceCtx.addEvent('action.received', { op: valid.op });
  let result: unknown;
  try {
    switch (valid.op) {
      case 'list_calendars':
        result = await listCalendars();
        break;
      case 'list_events':
        result = await listEvents(valid.params || {});
        break;
      case 'create_event':
        result = await createEvent(valid.params || {});
        break;
      default: {
        const _exhaustive: never = valid.op;
        throw new Error(`Unsupported operation: ${String(_exhaustive)}`);
      }
    }
    traceCtx.addEvent('action.completed', {
      op: valid.op,
      records: Array.isArray(result) ? result.length : 1,
    });
    return result;
  } catch (err: any) {
    const classified = classifyError(err);
    traceCtx.addEvent('action.failed', {
      op: valid.op,
      category: classified.category,
    });
    throw err;
  } finally {
    try {
      persistTrace(traceCtx.finalize());
    } catch (_) {
      /* persistence best-effort */
    }
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', demandOption: true })
    .parseSync();
  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string);
  const result = await handleAction(inputContent);
  console.log(JSON.stringify(result, null, 2));
};

const isDirectRun = process.env.NODE_ENV !== 'test';
if (isDirectRun) {
  main().catch(err => {
    logger.error(formatClassification(classifyError(err)));
    process.exit(1);
  });
}
