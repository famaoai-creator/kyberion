import {
  createCalendarEvent,
  listCalendarAgenda,
  listCalendars,
  queryCalendarFreeBusy,
  readGwsAuthStatus,
  readM365AuthStatus,
} from '@agent/core/calendar-workflow';

type ArgMap = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; args: ArgMap } {
  const [command = 'status', ...rest] = argv;
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
  return provider === 'm365' ? 'm365' : 'google-workspace';
}

function printHelp(): void {
  console.log('Usage: npm run calendar:workflow -- <status|list-calendars|agenda|freebusy|create-event> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  status        Check calendar auth readiness');
  console.log('  list-calendars  List calendars on the authenticated account');
  console.log('  agenda        Show upcoming events from a calendar');
  console.log('  freebusy      Query free/busy windows for one or more calendars');
  console.log('  create-event  Create a calendar event, optionally with meeting metadata');
  console.log('');
  console.log('Examples:');
  console.log('  npm run calendar:workflow -- status');
  console.log('  npm run calendar:workflow -- status --provider m365');
  console.log('  npm run calendar:workflow -- list-calendars');
  console.log('  npm run calendar:workflow -- list-calendars --provider m365');
  console.log('  npm run calendar:workflow -- agenda --calendar-id primary --days 7');
  console.log('  npm run calendar:workflow -- agenda --provider m365 --calendar-id primary --days 7');
  console.log('  npm run calendar:workflow -- freebusy --calendar-ids primary,team@example.com --time-min 2026-06-21T09:00:00+09:00 --time-max 2026-06-21T18:00:00+09:00');
  console.log('  npm run calendar:workflow -- create-event --summary "Planning" --start 2026-06-22T13:00:00+09:00 --end 2026-06-22T14:00:00+09:00 --with-meet');
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'status') {
    const provider = getProvider(args);
    const result = provider === 'm365' ? await readM365AuthStatus() : readGwsAuthStatus();
    console.log(JSON.stringify(result, null, 2));
    return;
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
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'list-calendars') {
    const result = await listCalendars(getProvider(args));
    console.log(JSON.stringify(result, null, 2));
    return;
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
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'create-event') {
    const provider = getProvider(args);
    const summary = getString(args, '--summary');
    const start = getString(args, '--start');
    const end = getString(args, '--end');
    if (!summary || !start || !end) {
      throw new Error('summary, start, and end are required for create-event');
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
      send_updates: sendUpdatesValue === 'all' || sendUpdatesValue === 'externalOnly' || sendUpdatesValue === 'none'
        ? sendUpdatesValue
        : undefined,
      with_meet: getBoolean(args, '--with-meet'),
      conference_request_id: getString(args, '--conference-request-id'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown calendar workflow command: ${command}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
