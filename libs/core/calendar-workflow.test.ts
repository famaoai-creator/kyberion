import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeServicePreset = vi.fn();
  return { executeServicePreset };
});

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

import { createCalendarEvent, listCalendarAgenda, listCalendars, queryCalendarFreeBusy } from './calendar-workflow.js';

describe('calendar-workflow helpers', () => {
  it('lists agenda items from the primary calendar by default', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      items: [
        {
          id: 'event-1',
          summary: 'Standup',
          start: { dateTime: '2026-06-21T09:00:00+09:00' },
          end: { dateTime: '2026-06-21T09:30:00+09:00' },
          htmlLink: 'https://example.com/event-1',
        },
      ],
    });

    const result = await listCalendarAgenda({});

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('google-workspace', 'calendar_events_list', {
      params: {
        calendarId: 'primary',
        timeMin: expect.any(String),
        timeMax: expect.any(String),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20,
      },
    });
    expect(result.events).toEqual([
      {
        id: 'event-1',
        summary: 'Standup',
        start: '2026-06-21T09:00:00+09:00',
        end: '2026-06-21T09:30:00+09:00',
        location: '',
        status: '',
        html_link: 'https://example.com/event-1',
        hangout_link: '',
      },
    ]);
  });

  it('queries free/busy windows for the requested calendars', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      calendars: {
        primary: {
          busy: [
            {
              start: '2026-06-21T10:00:00+09:00',
              end: '2026-06-21T11:00:00+09:00',
            },
          ],
        },
      },
    });

    const result = await queryCalendarFreeBusy({
      calendar_ids: ['primary', 'team@example.com'],
      time_min: '2026-06-21T09:00:00+09:00',
      time_max: '2026-06-21T18:00:00+09:00',
      time_zone: 'Asia/Tokyo',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('google-workspace', 'calendar_freebusy_query', {
      body: {
        timeMin: '2026-06-21T09:00:00+09:00',
        timeMax: '2026-06-21T18:00:00+09:00',
        timeZone: 'Asia/Tokyo',
        items: [{ id: 'primary' }, { id: 'team@example.com' }],
      },
    });
    expect(result.calendars[0]).toEqual({
      calendar_id: 'primary',
      busy: [{ start: '2026-06-21T10:00:00+09:00', end: '2026-06-21T11:00:00+09:00' }],
      errors: [],
    });
  });

  it('lists calendars on the authenticated account', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      items: [
        {
          id: 'primary',
          summary: 'Kyberion',
          description: 'Primary calendar',
          timeZone: 'Asia/Tokyo',
          accessRole: 'owner',
          selected: true,
          primary: true,
        },
      ],
    });

    const result = await listCalendars();

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('google-workspace', 'calendar_calendarList_list', {
      params: {},
    });
    expect(result.calendars).toEqual([
      {
        id: 'primary',
        summary: 'Kyberion',
        description: 'Primary calendar',
        time_zone: 'Asia/Tokyo',
        access_role: 'owner',
        selected: true,
        primary: true,
      },
    ]);
  });

  it('lists calendars from Microsoft 365 using Graph request wrappers', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      value: [
        {
          id: 'calendar-1',
          name: 'Engineering',
          timeZone: 'Asia/Tokyo',
          canEdit: true,
          isDefaultCalendar: true,
        },
      ],
    });

    const result = await listCalendars('m365');

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'calendar_list', {
      params: {},
    });
    expect(result.calendars).toEqual([
      {
        id: 'calendar-1',
        summary: 'Engineering',
        description: '',
        time_zone: 'Asia/Tokyo',
        access_role: 'owner',
        selected: false,
        primary: true,
      },
    ]);
  });

  it('lists Microsoft 365 calendar events from calendarView', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      value: [
        {
          id: 'event-graph-1',
          subject: 'Weekly sync',
          start: { dateTime: '2026-06-23T10:00:00+09:00' },
          end: { dateTime: '2026-06-23T10:30:00+09:00' },
          onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
          webLink: 'https://outlook.office.com/calendar/event-graph-1',
        },
      ],
    });

    const result = await listCalendarAgenda({
      provider: 'm365',
      calendar_id: 'primary',
      time_min: '2026-06-23T00:00:00+09:00',
      time_max: '2026-06-24T00:00:00+09:00',
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'calendar_events_list', {
      params: {
        calendarPath: 'me',
        timeMin: '2026-06-23T00%3A00%3A00%2B09%3A00',
        timeMax: '2026-06-24T00%3A00%3A00%2B09%3A00',
        maxResults: 20,
      },
    });
    expect(result.events).toEqual([
      {
        id: 'event-graph-1',
        summary: 'Weekly sync',
        start: '2026-06-23T10:00:00+09:00',
        end: '2026-06-23T10:30:00+09:00',
        location: '',
        status: '',
        html_link: 'https://outlook.office.com/calendar/event-graph-1',
        hangout_link: 'https://teams.microsoft.com/l/meetup-join/abc',
      },
    ]);
  });

  it('creates a meet-backed calendar event when requested', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      id: 'event-2',
      summary: 'Planning session',
      start: { dateTime: '2026-06-22T13:00:00+09:00' },
      end: { dateTime: '2026-06-22T14:00:00+09:00' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });

    const result = await createCalendarEvent({
      calendar_id: 'primary',
      summary: 'Planning session',
      start: '2026-06-22T13:00:00+09:00',
      end: '2026-06-22T14:00:00+09:00',
      time_zone: 'Asia/Tokyo',
      with_meet: true,
      attendees: ['team@example.com'],
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('google-workspace', 'calendar_events_insert', {
      params: {
        calendarId: 'primary',
        conferenceDataVersion: 1,
      },
      body: {
        summary: 'Planning session',
        start: { dateTime: '2026-06-22T13:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2026-06-22T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
        attendees: [{ email: 'team@example.com' }],
        conferenceData: {
          createRequest: {
            requestId: expect.any(String),
            conferenceSolutionKey: {
              type: 'hangoutsMeet',
            },
          },
        },
      },
    });
    expect(result.with_meet).toBe(true);
    expect(result.created_event.hangout_link).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('creates a Microsoft 365 meeting event via Graph request', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      id: 'event-graph-2',
      subject: 'Planning session',
      start: { dateTime: '2026-06-22T13:00:00+09:00' },
      end: { dateTime: '2026-06-22T14:00:00+09:00' },
      onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/xyz',
      webLink: 'https://outlook.office.com/calendar/event-graph-2',
    });

    const result = await createCalendarEvent({
      provider: 'm365',
      calendar_id: 'primary',
      summary: 'Planning session',
      start: '2026-06-22T13:00:00+09:00',
      end: '2026-06-22T14:00:00+09:00',
      time_zone: 'Asia/Tokyo',
      with_meet: true,
      attendees: ['team@example.com'],
    });

    expect(mocks.executeServicePreset).toHaveBeenCalledWith('m365', 'calendar_events_insert', {
      params: {
        calendarPath: 'me',
      },
      body: {
        subject: 'Planning session',
        start: { dateTime: '2026-06-22T13:00:00+09:00', timeZone: 'Asia/Tokyo' },
        end: { dateTime: '2026-06-22T14:00:00+09:00', timeZone: 'Asia/Tokyo' },
        attendees: [{
          emailAddress: { address: 'team@example.com' },
          type: 'required',
        }],
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
      },
    });
    expect(result.with_meet).toBe(true);
    expect(result.created_event.hangout_link).toBe('https://teams.microsoft.com/l/meetup-join/xyz');
  });
});
