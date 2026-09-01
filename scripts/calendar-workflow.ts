import {
  createCalendarEvent,
  listCalendarAgenda,
  listCalendars,
  queryCalendarFreeBusy,
  readGwsAuthStatus,
  readM365AuthStatus,
} from '@agent/core/calendar-workflow';
import { defineScript, isDirectScript } from './lib/harness.js';

type ArgMap = Record<string, string | boolean>;

const SHARED_FLAGS = new Set(['--json', '--dry-run', '--check', '--quiet']);

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help', args: {} };
  const filtered = argv.filter((arg) => !SHARED_FLAGS.has(arg));
  if (filtered[0] === '--') filtered.shift();
  const [command = 'status', ...rest] = filtered;
  const args: ArgMap = {};
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) continue;
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      args[current] = true;
      continue;
    }
    args[current] = next;
    index += 1;
  }
  return { command, args };
}

function getString(args: ArgMap, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function getBoolean(args: ArgMap, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

function getStringList(args: ArgMap, key: string): string[] {
  const value = getString(args, key);
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getProvider(args: ArgMap): 'google-workspace' | 'm365' {
  const provider = getString(args, '--provider', 'google-workspace');
  if (provider === 'google-workspace' || provider === 'm365') return provider;
  throw new Error(`Unsupported calendar provider: ${provider}`);
}

function helpText(): string {
  return [
    'Usage: pnpm kyberion calendar <status|list-calendars|agenda|freebusy|create-event> [options]',
    '',
    'Commands:',
    '  status        Check calendar auth readiness',
    '  list-calendars  List calendars on the authenticated account',
    '  agenda        Show upcoming events from a calendar',
    '  freebusy      Query free/busy windows for one or more calendars',
    '  create-event  Create a calendar event, optionally with meeting metadata',
    '',
    'Examples:',
    '  pnpm kyberion calendar status',
    '  pnpm kyberion calendar status --provider m365',
    '  pnpm kyberion calendar list-calendars',
    '  pnpm kyberion calendar list-calendars --provider m365',
    '  pnpm kyberion calendar agenda --calendar-id primary --days 7',
    '  pnpm kyberion calendar agenda --provider m365 --calendar-id primary --days 7',
    '  pnpm kyberion calendar freebusy --calendar-ids primary,team@example.com --time-min 2026-06-21T09:00:00+09:00 --time-max 2026-06-21T18:00:00+09:00',
    '  pnpm kyberion calendar create-event --summary "Planning" --start 2026-06-22T13:00:00+09:00 --end 2026-06-22T14:00:00+09:00 --with-meet',
  ].join('\n');
}

async function main(argv: string[], dryRun = false) {
  const { command, args } = parseArgs(argv);

  if (command === 'help') return helpText();

  if (command === 'status') {
    const provider = getProvider(args);
    const result = provider === 'm365' ? await readM365AuthStatus() : readGwsAuthStatus();
    return result;
  }

  if (command === 'agenda') {
    const provider = getProvider(args);
    const result = await listCalendarAgenda({
      provider,
      calendar_id: getString(args, '--calendar-id', 'primary'),
      days: Number(getString(args, '--days', '7')) || 7,
      max_results: Number(getString(args, '--max-results', '20')) || 20,
      query: getString(args, '--query'),
      time_min: getString(args, '--time-min'),
      time_max: getString(args, '--time-max'),
      time_zone: getString(args, '--time-zone'),
    });
    return result;
  }

  if (command === 'list-calendars') {
    const result = await listCalendars(getProvider(args));
    return result;
  }

  if (command === 'freebusy') {
    const provider = getProvider(args);
    const timeMin = getString(args, '--time-min');
    const timeMax = getString(args, '--time-max');
    if (!timeMin || !timeMax) {
      throw new Error('time_min and time_max are required for freebusy');
    }
    const result = await queryCalendarFreeBusy({
      provider,
      calendar_id: getString(args, '--calendar-id', 'primary'),
      calendar_ids: getStringList(args, '--calendar-ids'),
      time_min: timeMin,
      time_max: timeMax,
      time_zone: getString(args, '--time-zone'),
    });
    return result;
  }

  if (command === 'create-event') {
    const provider = getProvider(args);
    const summary = getString(args, '--summary');
    const start = getString(args, '--start');
    const end = getString(args, '--end');
    if (!summary || !start || !end) {
      throw new Error('summary, start, and end are required for create-event');
    }
    if (dryRun) {
      return {
        ok: true,
        dry_run: true,
        action: 'create-event',
        provider,
        calendar_id: getString(args, '--calendar-id', 'primary'),
        summary,
        start,
        end,
        with_meet: getBoolean(args, '--with-meet'),
        attendees: getStringList(args, '--attendees'),
      };
    }
    const sendUpdatesValue = getString(args, '--send-updates');
    const result = await createCalendarEvent({
      provider,
      calendar_id: getString(args, '--calendar-id', 'primary'),
      summary,
      start,
      end,
      description: getString(args, '--description'),
      location: getString(args, '--location'),
      attendees: getStringList(args, '--attendees'),
      time_zone: getString(args, '--time-zone'),
      send_updates:
        sendUpdatesValue === 'all' ||
        sendUpdatesValue === 'externalOnly' ||
        sendUpdatesValue === 'none'
          ? sendUpdatesValue
          : undefined,
      with_meet: getBoolean(args, '--with-meet'),
      conference_request_id: getString(args, '--conference-request-id'),
    });
    return result;
  }

  throw new Error(`Unknown calendar workflow command: ${command}`);
}

const script = defineScript({
  name: 'calendar workflow',
  run: ({ argv, dryRun, check, print }) =>
    main(argv, dryRun || check).then((result) => {
      if (result !== undefined) print(result);
      return result;
    }),
});
if (
  isDirectScript(import.meta.url, 'calendar-workflow.ts') ||
  isDirectScript(import.meta.url, 'calendar-workflow.js')
) {
  void script();
}
