/**
 * meeting_readiness_check.ts — PG-07: pre-meeting grant readiness.
 *
 * Lists the calendar's joinable meetings in a window, evaluates the grant
 * readiness profile (default `meeting.online`) for each one with its meeting
 * URL and calendar series id, and reports the meetings that would be refused.
 * The report carries a localized notification title / body; the scheduled
 * pipelines (`pipelines/meeting-readiness-*.json`) send it with
 * `system:notify` only when something is missing. Read-only: no grant is
 * created or used, no mission evidence is written.
 *
 * Windows:
 *   next_day — the whole of tomorrow in the host's local time zone (the
 *              pipelines' schedule time zone is expected to match it); run
 *              once in the evening.
 *   soon     — meetings starting 60–75 minutes after the current 15-minute
 *              slot; run every 15 minutes. The slot (not the live clock)
 *              anchors the window, so a late tick neither skips nor repeats
 *              a meeting.
 *
 * The check runs without a mission: it answers whether the tenant's standing
 * grants cover each meeting. A mission's own voice-consent.json (or a mission
 * bound to another tenant) is not considered.
 *
 * Also reachable as `pnpm kyberion grants upcoming`.
 */
import { t as catalogT } from '@agent/core/t';
import {
  evaluateGrantReadiness,
  type GrantReadinessItem,
} from '@agent/core/governance/grant-readiness';
import { handleAction as handleCalendarAction } from '../libs/actuators/calendar-actuator/src/calendar-actuator-helpers.js';
import {
  listUpcomingMeetings,
  type CalendarLikeEvent,
  type UpcomingMeeting,
} from '../libs/actuators/meeting-actuator/src/meeting-target-resolve.js';
import { defineScript, isDirectScript } from './lib/harness.js';

export type MeetingReadinessStage = 'next_day' | 'soon';

export interface MeetingReadinessOptions {
  stage?: MeetingReadinessStage;
  /** Explicit window (minutes from now); overrides `stage`. */
  from_min?: number;
  to_min?: number;
  profile?: string;
  tenant_slug?: string;
  calendar_names?: string[];
  now?: Date;
}

export interface MeetingReadinessEntry {
  title?: string;
  start: string;
  platform: string;
  url: string;
  series_id?: string;
  ready: boolean;
  missing: string[];
  remedies: string[];
}

export interface MeetingReadinessReport {
  checked_at: string;
  profile: string;
  window: { start: string; end: string };
  meetings: MeetingReadinessEntry[];
  not_ready_count: number;
  /** Localized notification text; empty when every meeting is ready. */
  notify_title: string;
  notify_message: string;
}

export interface MeetingReadinessDeps {
  listEvents?: (window: {
    start: Date;
    end: Date;
    calendar_names?: string[];
  }) => Promise<CalendarLikeEvent[]>;
  evaluate?: typeof evaluateGrantReadiness;
}

const SOON_WINDOW_MIN = { from: 60, to: 75 } as const;

/** [start, end) of the check window in absolute time. */
export function resolveReadinessWindow(options: MeetingReadinessOptions): {
  start: Date;
  end: Date;
} {
  const now = options.now ?? new Date();
  if (options.from_min !== undefined || options.to_min !== undefined) {
    const from = options.from_min ?? 0;
    const to = options.to_min ?? from + 24 * 60;
    if (!(to > from)) throw new Error('[meeting-readiness] to_min must be greater than from_min');
    return {
      start: new Date(now.getTime() + from * 60_000),
      end: new Date(now.getTime() + to * 60_000),
    };
  }
  if ((options.stage ?? 'next_day') === 'soon') {
    const slotMs = (SOON_WINDOW_MIN.to - SOON_WINDOW_MIN.from) * 60_000;
    const slot = Math.floor(now.getTime() / slotMs) * slotMs;
    return {
      start: new Date(slot + SOON_WINDOW_MIN.from * 60_000),
      end: new Date(slot + SOON_WINDOW_MIN.to * 60_000),
    };
  }
  const start = new Date(now);
  start.setHours(24, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

async function listCalendarEvents(window: {
  start: Date;
  end: Date;
  calendar_names?: string[];
}): Promise<CalendarLikeEvent[]> {
  const result = await handleCalendarAction({
    op: 'list_events',
    params: {
      start_date: window.start.toISOString(),
      end_date: window.end.toISOString(),
      ...(window.calendar_names?.length ? { calendar_names: window.calendar_names } : {}),
    },
  });
  return Array.isArray(result) ? (result as CalendarLikeEvent[]) : [];
}

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The command the notification points to: from now until the end of this
 * window, so it still lists the notified meetings when run a little later.
 */
function followUpCommand(input: {
  now: Date;
  window: { start: Date; end: Date };
  profile: string;
  tenant?: string;
  calendars?: string[];
}): string {
  const toMin = Math.ceil((input.window.end.getTime() - input.now.getTime()) / 60_000);
  return [
    'pnpm kyberion grants upcoming',
    `--profile ${input.profile}`,
    '--from-min 0',
    `--to-min ${Math.max(1, toMin)}`,
    ...(input.tenant ? [`--tenant ${input.tenant}`] : []),
    ...(input.calendars ?? []).map((name) => `--calendar ${JSON.stringify(name)}`),
  ].join(' ');
}

function remediesOf(items: GrantReadinessItem[]): string[] {
  return items
    .filter((item) => item.required && !item.allowed && item.remedy)
    .map((item) => item.remedy as string);
}

export async function runMeetingReadinessCheck(
  options: MeetingReadinessOptions = {},
  deps: MeetingReadinessDeps = {}
): Promise<MeetingReadinessReport> {
  const now = options.now ?? new Date();
  const profile = options.profile || 'meeting.online';
  const window = resolveReadinessWindow({ ...options, now });
  const events = await (deps.listEvents ?? listCalendarEvents)({
    ...window,
    ...(options.calendar_names?.length ? { calendar_names: options.calendar_names } : {}),
  });
  const upcoming: UpcomingMeeting[] = listUpcomingMeetings(events, {
    now: now.getTime(),
    from_min: (window.start.getTime() - now.getTime()) / 60_000,
    to_min: (window.end.getTime() - now.getTime()) / 60_000,
  });
  const evaluate = deps.evaluate ?? evaluateGrantReadiness;
  const meetings = upcoming.map((meeting): MeetingReadinessEntry => {
    const report = evaluate({
      profile,
      context: {
        ...(options.tenant_slug ? { tenant_slug: options.tenant_slug } : {}),
        meeting: {
          url: meeting.url,
          ...(meeting.series_id ? { series_id: meeting.series_id } : {}),
        },
        now,
      },
    });
    return {
      ...(meeting.title ? { title: meeting.title } : {}),
      start: meeting.start,
      platform: meeting.platform,
      url: meeting.url,
      ...(meeting.series_id ? { series_id: meeting.series_id } : {}),
      ready: report.ready,
      missing: report.missing,
      remedies: remediesOf(report.items),
    };
  });
  const notReady = meetings.filter((meeting) => !meeting.ready);
  const notifyMessage = notReady.length
    ? catalogT('meeting_readiness:notify_body', {
        meetings: notReady
          .map((meeting) => `${meeting.title || meeting.platform} (${localTime(meeting.start)})`)
          .join(', '),
        command: followUpCommand({
          now,
          window,
          profile,
          tenant: options.tenant_slug,
          calendars: options.calendar_names,
        }),
      })
    : '';
  return {
    checked_at: now.toISOString(),
    profile,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    meetings,
    not_ready_count: notReady.length,
    notify_title: notReady.length
      ? catalogT('meeting_readiness:notify_title', { count: notReady.length })
      : '',
    notify_message: notifyMessage,
  };
}

export function renderMeetingReadiness(report: MeetingReadinessReport): string {
  const lines = [
    `# Meeting readiness (${report.profile})`,
    '',
    `- window: ${localTime(report.window.start)} – ${localTime(report.window.end)}`,
    `- meetings: ${report.meetings.length}, not ready: ${report.not_ready_count}`,
    '- checks the tenant standing grants (no mission context)',
  ];
  if (report.meetings.length === 0) {
    lines.push('', '> [grants] no joinable meeting in the window');
    return lines.join('\n');
  }
  for (const meeting of report.meetings) {
    lines.push(
      '',
      `## ${meeting.title || meeting.platform} — ${localTime(meeting.start)}: ${meeting.ready ? 'ready' : `missing ${meeting.missing.join(', ')}`}`,
      '',
      `- url: ${meeting.url}`,
      ...(meeting.series_id ? [`- series: ${meeting.series_id}`] : []),
      ...meeting.remedies.map((remedy) => `- to allow it: \`${remedy}\``)
    );
  }
  return lines.join('\n');
}

function numberFlag(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function stringFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function parseMeetingReadinessArgs(argv: string[]): MeetingReadinessOptions {
  const stage = stringFlag(argv, '--stage');
  if (stage && stage !== 'next_day' && stage !== 'soon') {
    throw new Error('--stage must be next_day or soon');
  }
  const calendars = argv.flatMap((token, index) =>
    token === '--calendar' && argv[index + 1] ? [argv[index + 1] as string] : []
  );
  const fromMin = numberFlag(argv, '--from-min');
  const toMin = numberFlag(argv, '--to-min');
  const profile = stringFlag(argv, '--profile');
  const tenant = stringFlag(argv, '--tenant');
  return {
    ...(stage ? { stage: stage as MeetingReadinessStage } : {}),
    ...(fromMin !== undefined ? { from_min: fromMin } : {}),
    ...(toMin !== undefined ? { to_min: toMin } : {}),
    ...(profile ? { profile } : {}),
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(calendars.length ? { calendar_names: calendars } : {}),
  };
}

if (
  isDirectScript(import.meta.url, 'meeting_readiness_check.ts') ||
  isDirectScript(import.meta.url, 'meeting_readiness_check.js')
) {
  void defineScript({
    name: 'meeting:readiness-check',
    flags: [],
    async run(context) {
      const report = await runMeetingReadinessCheck(parseMeetingReadinessArgs(context.argv));
      context.print(
        context.argv.includes('--json')
          ? JSON.stringify(report, null, 2)
          : renderMeetingReadiness(report)
      );
      return report;
    },
  })();
}
