import { describe, expect, it, vi } from 'vitest';
import { googleCalendarEventsCollector } from './provider-calendar.js';
import { matchesInformationIntakeRecipe, loadInformationIntakeRecipes } from './recipes.js';
import type { InformationAssetLocation, InformationAssetObservation } from './types.js';
import type { CollectorSubject } from './provider.js';

const now = new Date('2026-11-27T09:00:00Z');
const at = (hours: number) => new Date(now.getTime() + hours * 3600000).toISOString();
const location = (
  selectors: InformationAssetLocation['selectors'] = {}
): InformationAssetLocation => ({
  location_id: 'team-calendar',
  asset_type: 'calendar.meeting',
  scope: { tenant_slug: 'acme', organization_id: 'engineering' },
  binding_id: 'google-acme',
  service_id: 'google-workspace',
  collector_id: 'google_calendar.events',
  selectors,
  tier: 'confidential',
  authoritative: true,
  freshness_seconds: 1800,
  enabled: true,
  version: 1,
  updated_at: now.toISOString(),
});
const event = (id: string, startH: number, endH: number, extra: Record<string, unknown> = {}) => ({
  id,
  etag: '"' + id + '-1"',
  status: 'confirmed',
  summary: 'Quarterly review ' + id,
  start: { dateTime: at(startH) },
  end: { dateTime: at(endH) },
  attendees: [
    { email: 'me@acme.test', self: true, responseStatus: 'accepted' },
    { email: 'pat@client.test', responseStatus: 'accepted' },
  ],
  htmlLink: 'https://calendar.google.com/event?eid=' + id,
  ...extra,
});

describe('google_calendar.events collector', () => {
  it('requests a bounded window around now and emits prep and follow-up phases', async () => {
    const call = vi.fn(async () => ({
      items: [
        event('soon', 2, 3),
        event('done', -3, -2),
        event('now', -1, 1),
        event('later', 48, 49),
      ],
    }));
    const page = await googleCalendarEventsCollector.collect(location(), {}, call, now);
    expect(call).toHaveBeenCalledWith('calendar_events_list', {
      params: {
        calendarId: 'primary',
        timeMin: at(-24),
        timeMax: at(24),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      },
    });
    expect(page.complete).toBe(true);
    expect(page.subjects.map((s) => [s.subject_id, s.event_type])).toEqual([
      ['primary/soon', 'meeting.upcoming'],
      ['primary/done', 'meeting.ended'],
    ]);
    const soon = page.subjects[0]!;
    expect(soon.change_id).toMatch(/^upcoming:[a-f0-9]{32}$/);
    expect(soon.occurred_at).toBe(at(2));
    expect(soon.source_url).toBe('https://calendar.google.com/event?eid=soon');
    expect(soon.data).toMatchObject({
      phase: 'upcoming',
      start: at(2),
      end: at(3),
      attendees: [
        { email: 'me@acme.test', self: true, response_status: 'accepted' },
        { email: 'pat@client.test', response_status: 'accepted' },
      ],
    });
    expect(page.subjects[1]!.occurred_at).toBe(at(-2));
  });

  it('skips cancelled, declined, all-day and non-meeting entries', async () => {
    const page = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({
        items: [
          event('cancelled', 1, 2, { status: 'cancelled' }),
          event('declined', 1, 2, {
            attendees: [{ email: 'me@acme.test', self: true, responseStatus: 'declined' }],
          }),
          event('allday', 1, 2, { start: { date: '2026-11-27' }, end: { date: '2026-11-28' } }),
          event('focus', 1, 2, { eventType: 'focusTime' }),
          event('solo', 1, 2, {
            attendees: [
              { email: 'me@acme.test', self: true, responseStatus: 'accepted' },
              { email: 'room-1@resource.test', resource: true, responseStatus: 'accepted' },
            ],
            organizer: { email: 'me@acme.test', self: true },
          }),
          event('ok', 1, 2),
        ],
      }),
      now
    );
    expect(page.subjects.map((s) => s.subject_id)).toEqual(['primary/ok']);
  });

  it('pages with the window the pass started with, even after time moves on', async () => {
    const call = vi.fn(async () => ({ items: [], nextPageToken: 'p2' }));
    const first = await googleCalendarEventsCollector.collect(
      location({ calendar_id: 'team@acme.test', prep_lead_seconds: 3600 }),
      {},
      call,
      now
    );
    expect(call.mock.calls[0]![1]).toMatchObject({
      params: { calendarId: 'team@acme.test', timeMin: at(-24), timeMax: at(1) },
    });
    expect(first).toEqual({
      subjects: [],
      complete: false,
      next: { page_token: 'p2', checkpoint: at(-24) + '|' + at(1) },
    });
    const later = new Date(now.getTime() + 2 * 3600000);
    await googleCalendarEventsCollector.collect(
      location({ calendar_id: 'team@acme.test', prep_lead_seconds: 3600 }),
      first.next,
      call,
      later
    );
    expect(call.mock.calls[1]![1]).toMatchObject({
      params: { timeMin: at(-24), timeMax: at(1), pageToken: 'p2' },
    });
  });

  it('drops a page token that has no recorded window and starts a fresh pass', async () => {
    const call = vi.fn(async () => ({ items: [] }));
    await googleCalendarEventsCollector.collect(location(), { page_token: 'stale' }, call, now);
    expect(call.mock.calls[0]![1]).not.toHaveProperty('params.pageToken');
  });

  it('rejects out-of-range windows instead of silently widening intake', async () => {
    await expect(
      googleCalendarEventsCollector.collect(
        location({ prep_lead_seconds: 30 * 86400 }),
        {},
        async () => ({ items: [] }),
        now
      )
    ).rejects.toThrow('collector_invalid_prep_lead_seconds');
  });

  it('reschedules re-observe while unchanged and RSVP-only updates keep the change id', async () => {
    const first = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({ items: [event('m', 2, 3)] }),
      now
    );
    const again = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({ items: [event('m', 2, 3)] }),
      now
    );
    const moved = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({ items: [event('m', 4, 5, { etag: '"m-2"' })] }),
      now
    );
    const rsvp = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({
        items: [
          event('m', 2, 3, {
            etag: '"m-rsvp"',
            attendees: [
              { email: 'me@acme.test', self: true, responseStatus: 'accepted' },
              { email: 'pat@client.test', responseStatus: 'tentative' },
            ],
          }),
        ],
      }),
      now
    );
    expect(again.subjects[0]!.change_id).toBe(first.subjects[0]!.change_id);
    // An RSVP change alone must not prepare the meeting again.
    expect(rsvp.subjects[0]!.change_id).toBe(first.subjects[0]!.change_id);
    expect(moved.subjects[0]!.change_id).not.toBe(first.subjects[0]!.change_id);
  });

  it('routes each phase to exactly one calendar recipe', async () => {
    const page = await googleCalendarEventsCollector.collect(
      location(),
      {},
      async () => ({ items: [event('soon', 2, 3), event('done', -3, -2)] }),
      now
    );
    const recipes = loadInformationIntakeRecipes();
    const toObservation = (subject: CollectorSubject): InformationAssetObservation => ({
      ...subject,
      scope: { tenant_slug: 'acme', organization_id: 'engineering' },
      asset_type: 'calendar.meeting',
      location_id: 'team-calendar',
      binding_id: 'google-acme',
      service_id: 'google-workspace',
      event_id: 'a'.repeat(64),
      content_sha256: 'b'.repeat(64),
      observed_at: now.toISOString(),
    });
    const matched = page.subjects.map((subject) =>
      recipes
        .filter((recipe) => matchesInformationIntakeRecipe(toObservation(subject), recipe))
        .map((recipe) => recipe.recipe_id)
    );
    expect(matched).toEqual([['calendar.meeting_prep'], ['calendar.meeting_followup']]);
  });
});
