import type { InformationAssetCollector, CollectorSubject } from './provider.js';
import { object, rows, text, optionalText, jsonObject, providerRevision } from './provider.js';

const DAY_SECONDS = 86400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const DESCRIPTION_LIMIT = 8000;
/** Calendar entries that are not meetings with people; they never produce prep or follow-up work. */
const NON_MEETING_EVENT_TYPES = new Set(['workingLocation', 'outOfOffice', 'focusTime']);

function windowSeconds(value: unknown, fallback: number, name: string): number {
  const seconds = value ?? fallback;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 300 ||
    seconds > WEEK_SECONDS
  )
    throw new Error('collector_invalid_' + name);
  return seconds;
}

function eventInstant(value: unknown, name: string): number | undefined {
  const slot = object(value ?? {});
  // All-day entries carry only `date`; they are reminders or blocks, not meetings to prepare.
  const dateTime = optionalText(slot.dateTime);
  if (!dateTime) return undefined;
  const at = Date.parse(dateTime);
  if (!Number.isFinite(at)) throw new Error('collector_invalid_' + name);
  return at;
}

/**
 * Snapshot pass over a moving window around now. A meeting yields at most two
 * observations: `meeting.upcoming` inside the prep lead, `meeting.ended` inside
 * the follow-up window. The change id hashes what the meeting is (time, title,
 * description, place, the set of other people) rather than the provider etag,
 * so a reschedule or agenda edit is observed again while an RSVP change or an
 * unchanged meeting dedupes to the same event id on every poll.
 */
export const googleCalendarEventsCollector: InformationAssetCollector = {
  id: 'google_calendar.events',
  service_id: 'google-workspace',
  asset_types: ['calendar.meeting'],
  actions: ['calendar_events_list'],
  async collect(location, cursor, call, now = new Date()) {
    const calendarId = optionalText(location.selectors.calendar_id) ?? 'primary';
    if (calendarId.length > 1024) throw new Error('collector_invalid_calendar_id');
    const prepLead = windowSeconds(
      location.selectors.prep_lead_seconds,
      DAY_SECONDS,
      'prep_lead_seconds'
    );
    const followupWindow = windowSeconds(
      location.selectors.followup_window_seconds,
      DAY_SECONDS,
      'followup_window_seconds'
    );
    const nowMs = now.getTime();
    // A page token is bound to the query that issued it: resume a partial pass
    // with the window it started with instead of a window shifted by elapsed time.
    const resumed = cursor.page_token ? resumedWindow(cursor.checkpoint) : undefined;
    const timeMin = resumed?.[0] ?? new Date(nowMs - followupWindow * 1000).toISOString();
    const timeMax = resumed?.[1] ?? new Date(nowMs + prepLead * 1000).toISOString();
    const response = object(
      await call('calendar_events_list', {
        params: {
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
          ...(resumed ? { pageToken: cursor.page_token } : {}),
        },
      })
    );
    if (response.error) throw new Error('collector_calendar_error_response');
    const items = rows(response.items ?? []);
    if (items.length > 250) throw new Error('collector_calendar_page_exceeded');
    const subjects: CollectorSubject[] = [];
    for (const event of items) {
      if (event.status === 'cancelled') continue;
      if (typeof event.eventType === 'string' && NON_MEETING_EVENT_TYPES.has(event.eventType))
        continue;
      const attendees = rows(event.attendees ?? []);
      if (attendees.some((a) => a.self === true && a.responseStatus === 'declined')) continue;
      // "Meetings with people": a solo block (gym, errands) has no one else to meet.
      const others = attendees.filter((a) => a.self !== true && a.resource !== true);
      const organizer = event.organizer ? object(event.organizer) : undefined;
      if (!others.length && (!organizer || organizer.self === true)) continue;
      const start = eventInstant(event.start, 'event_start');
      const end = eventInstant(event.end, 'event_end');
      if (start === undefined || end === undefined) continue;
      const phase =
        start > nowMs && start - nowMs <= prepLead * 1000
          ? 'upcoming'
          : end <= nowMs && nowMs - end <= followupWindow * 1000
            ? 'ended'
            : undefined;
      // A meeting in progress has nothing to prepare and nothing to follow up yet.
      if (!phase) continue;
      const id = text(event.id, 'event_id');
      const description = optionalText(event.description);
      const revision = providerRevision({
        start,
        end,
        summary: optionalText(event.summary) ?? '',
        description: description ?? '',
        location: optionalText(event.location) ?? '',
        people: others
          .map((a) => optionalText(a.email) ?? optionalText(a.displayName) ?? '')
          .sort(),
      }).slice(0, 32);
      subjects.push({
        subject_id: calendarId + '/' + id,
        change_id: phase + ':' + revision,
        event_type: 'meeting.' + phase,
        occurred_at: new Date(phase === 'upcoming' ? start : end).toISOString(),
        ...(optionalText(event.htmlLink) ? { source_url: event.htmlLink as string } : {}),
        data: jsonObject({
          id,
          calendar_id: calendarId,
          phase,
          summary: optionalText(event.summary) ?? '',
          ...(description ? { description: description.slice(0, DESCRIPTION_LIMIT) } : {}),
          ...(optionalText(event.location) ? { location: event.location } : {}),
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          ...(event.organizer ? { organizer: pickPerson(object(event.organizer)) } : {}),
          attendees: attendees.slice(0, 200).map(pickPerson),
          ...(optionalText(event.recurringEventId)
            ? { recurring_event_id: event.recurringEventId }
            : {}),
          ...(optionalText(event.hangoutLink) ? { hangout_link: event.hangoutLink } : {}),
        }),
      });
    }
    const token = optionalText(response.nextPageToken);
    return {
      subjects,
      complete: !token,
      next: token ? { page_token: token, checkpoint: timeMin + '|' + timeMax } : {},
    };
  },
};

function resumedWindow(checkpoint: string | undefined): [string, string] | undefined {
  const [min, max, extra] = (checkpoint ?? '').split('|');
  // No usable window means the token cannot be trusted; start a fresh pass.
  if (!min || !max || extra !== undefined) return undefined;
  if (!Number.isFinite(Date.parse(min)) || !Number.isFinite(Date.parse(max))) return undefined;
  return [min, max];
}

function pickPerson(person: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(optionalText(person.email) ? { email: person.email } : {}),
    ...(optionalText(person.displayName) ? { display_name: person.displayName } : {}),
    ...(optionalText(person.responseStatus) ? { response_status: person.responseStatus } : {}),
    ...(person.self === true ? { self: true } : {}),
    ...(person.organizer === true ? { organizer: true } : {}),
    ...(person.optional === true ? { optional: true } : {}),
  };
}
