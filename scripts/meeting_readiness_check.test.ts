import { describe, expect, it, vi } from 'vitest';
import {
  parseMeetingReadinessArgs,
  renderMeetingReadiness,
  resolveReadinessWindow,
  runMeetingReadinessCheck,
} from './meeting_readiness_check.js';

const NOW = new Date(2026, 9, 20, 18, 0, 0); // local 2026-10-20 18:00

const events = [
  {
    title: 'Weekly Sync',
    start: new Date(2026, 9, 21, 10, 0).toISOString(),
    end: new Date(2026, 9, 21, 10, 30).toISOString(),
    location: '',
    description: '',
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    series_id: 'series-weekly',
  },
  {
    title: 'Customer call',
    start: new Date(2026, 9, 21, 14, 0).toISOString(),
    location: 'https://zoom.us/j/123456789',
    description: '',
  },
  { title: 'Lunch', start: new Date(2026, 9, 21, 12, 0).toISOString(), location: 'Cafe' },
];

describe('resolveReadinessWindow', () => {
  it('next_day covers the whole of tomorrow in local time', () => {
    expect(resolveReadinessWindow({ now: NOW })).toEqual({
      start: new Date(2026, 9, 21, 0, 0, 0),
      end: new Date(2026, 9, 22, 0, 0, 0),
    });
  });

  it('soon covers 60-75 minutes after the 15-minute slot; an explicit window overrides the stage', () => {
    expect(resolveReadinessWindow({ now: NOW, stage: 'soon' })).toEqual({
      start: new Date(2026, 9, 20, 19, 0),
      end: new Date(2026, 9, 20, 19, 15),
    });
    // A tick that fires 40 s late still checks the same slot.
    expect(
      resolveReadinessWindow({ now: new Date(2026, 9, 20, 18, 0, 40), stage: 'soon' })
    ).toEqual({ start: new Date(2026, 9, 20, 19, 0), end: new Date(2026, 9, 20, 19, 15) });
    expect(resolveReadinessWindow({ now: NOW, stage: 'soon', from_min: 0, to_min: 30 })).toEqual({
      start: NOW,
      end: new Date(2026, 9, 20, 18, 30),
    });
    expect(() => resolveReadinessWindow({ now: NOW, from_min: 30, to_min: 10 })).toThrow(
      /to_min must be greater/
    );
  });
});

describe('runMeetingReadinessCheck', () => {
  it('checks each joinable meeting with its URL and series id and builds the notification', async () => {
    const listEvents = vi.fn(async () => events);
    const evaluate = vi.fn(({ context }: { context: { meeting?: { series_id?: string } } }) => {
      const ready = context.meeting?.series_id === 'series-weekly';
      return {
        profile: 'meeting.online',
        description: 'online',
        ready,
        missing: ready ? [] : ['meeting.recording'],
        items: ready
          ? []
          : [
              {
                capability: 'meeting.recording',
                required: true,
                allowed: false,
                remedy: 'pnpm kyberion grants grant --capability meeting.recording',
              },
            ],
      };
    });
    const report = await runMeetingReadinessCheck(
      { now: NOW, tenant_slug: 'acme', calendar_names: ['Work'] },
      { listEvents, evaluate }
    );
    expect(listEvents).toHaveBeenCalledWith({
      start: new Date(2026, 9, 21, 0, 0, 0),
      end: new Date(2026, 9, 22, 0, 0, 0),
      calendar_names: ['Work'],
    });
    expect(evaluate).toHaveBeenNthCalledWith(1, {
      profile: 'meeting.online',
      context: {
        tenant_slug: 'acme',
        meeting: { url: 'https://meet.google.com/abc-defg-hij', series_id: 'series-weekly' },
        now: NOW,
      },
    });
    expect(report.meetings.map((meeting) => [meeting.title, meeting.ready])).toEqual([
      ['Weekly Sync', true],
      ['Customer call', false],
    ]);
    expect(report.not_ready_count).toBe(1);
    expect(report.notify_title).toBeTruthy();
    expect(report.notify_message).toContain('Customer call (10/21 14:00)');
    // The suggested command covers the notified meeting and keeps the tenant.
    expect(report.notify_message).toContain(
      'pnpm kyberion grants upcoming --profile meeting.online --from-min 0 --to-min 1800 --tenant acme --calendar "Work"'
    );
    expect(renderMeetingReadiness(report)).toContain(
      '- to allow it: `pnpm kyberion grants grant --capability meeting.recording`'
    );
  });

  it('stays silent when every meeting is ready', async () => {
    const report = await runMeetingReadinessCheck(
      { now: NOW },
      {
        listEvents: async () => [],
        evaluate: vi.fn(),
      }
    );
    expect(report).toMatchObject({
      meetings: [],
      not_ready_count: 0,
      notify_title: '',
      notify_message: '',
    });
    expect(renderMeetingReadiness(report)).toContain('no joinable meeting in the window');
  });
});

describe('parseMeetingReadinessArgs', () => {
  it('reads stage, window, profile, tenant and repeated calendars', () => {
    expect(
      parseMeetingReadinessArgs([
        '--stage',
        'soon',
        '--from-min',
        '10',
        '--to-min',
        '40',
        '--profile',
        'meeting.in_room',
        '--tenant',
        'acme',
        '--calendar',
        'Work',
        '--calendar',
        'Team',
      ])
    ).toEqual({
      stage: 'soon',
      from_min: 10,
      to_min: 40,
      profile: 'meeting.in_room',
      tenant_slug: 'acme',
      calendar_names: ['Work', 'Team'],
    });
    expect(() => parseMeetingReadinessArgs(['--stage', 'later'])).toThrow(/next_day or soon/);
  });
});
