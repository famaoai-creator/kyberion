import { describe, expect, it } from 'vitest';
import {
  extractMeetingUrl,
  listUpcomingMeetings,
  resolveNextMeetingTarget,
} from './meeting-target-resolve.js';

describe('extractMeetingUrl', () => {
  it('prefers location over description', () => {
    expect(
      extractMeetingUrl({
        location: 'https://meet.google.com/abc-defg-hij',
        description: 'Join: https://zoom.us/j/123',
      })
    ).toEqual({
      url: 'https://meet.google.com/abc-defg-hij',
      platform: 'meet',
      source: 'location',
    });
  });

  it('finds Teams links in descriptions with markup', () => {
    expect(
      extractMeetingUrl({
        description: '<a href="https://teams.microsoft.com/l/meetup-join/19%3Aabc">Join</a>',
      }).platform
    ).toBe('teams');
  });

  it('ignores non-meeting URLs', () => {
    expect(
      extractMeetingUrl({ location: 'Room 3F', description: 'See https://example.com/a' })
    ).toEqual({});
  });

  it('rejects bare microsoft.com pages without a Teams join path', () => {
    expect(extractMeetingUrl({ description: 'https://microsoft.com/en-us/about' })).toEqual({});
  });
});

describe('resolveNextMeetingTarget', () => {
  const NOW = Date.parse('2026-09-06T09:00:00+09:00');

  it('picks the earliest meeting starting within the window', () => {
    const target = resolveNextMeetingTarget(
      [
        {
          title: 'Later',
          start: '2026-09-06T09:08:00+09:00',
          end: '2026-09-06T09:30:00+09:00',
          location: 'https://zoom.us/j/222',
        },
        {
          title: 'Now',
          start: '2026-09-06T08:59:00+09:00',
          end: '2026-09-06T09:30:00+09:00',
          location: 'https://meet.google.com/abc-defg-hij',
        },
        {
          title: 'Too late',
          start: '2026-09-06T10:00:00+09:00',
          location: 'https://meet.google.com/xyz-xyz-xyz',
        },
      ],
      { now: NOW }
    );
    expect(target).toMatchObject({
      found: true,
      title: 'Now',
      platform: 'meet',
      join_duration_sec: 1800,
    });
    expect(target.file_slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{4}-meet$/u);
    expect(target.starts_in_sec).toBe(-60);
  });

  it('reports no target outside the window', () => {
    expect(resolveNextMeetingTarget([], { now: NOW })).toEqual({
      found: false,
      reason: 'no joinable meeting in window',
    });
  });

  it('clamps the join duration to the maximum', () => {
    const target = resolveNextMeetingTarget(
      [
        {
          title: 'Long',
          start: '2026-09-06T09:00:00+09:00',
          end: '2026-09-06T13:00:00+09:00',
          location: 'https://meet.google.com/abc-defg-hij',
        },
      ],
      { now: NOW, max_duration_sec: 600 }
    );
    expect(target.join_duration_sec).toBe(600);
  });
});

describe('calendar series id and conference link (PG-07)', () => {
  const now = '2026-09-06T08:00:00+09:00';
  const weekly = {
    title: 'Weekly Sync',
    start: '2026-09-06T09:10:00+09:00',
    end: '2026-09-06T09:40:00+09:00',
    location: 'Room 3',
    meeting_url: 'https://meet.google.com/abc-defg-hij',
    series_id: 'series-weekly',
  };

  it('prefers the provider conference link and carries the series id to the join target', () => {
    expect(extractMeetingUrl(weekly)).toEqual({
      url: 'https://meet.google.com/abc-defg-hij',
      platform: 'meet',
      source: 'meeting_url',
    });
    expect(resolveNextMeetingTarget([weekly], { now: '2026-09-06T09:05:00+09:00' })).toMatchObject({
      found: true,
      series_id: 'series-weekly',
    });
  });

  it('drops the series id when the URL comes from free text, not the conference field', () => {
    const edited = {
      ...weekly,
      meeting_url: undefined,
      description: 'This week: https://meet.google.com/zzz-zzzz-zzz',
    };
    const target = resolveNextMeetingTarget([edited], { now: '2026-09-06T09:05:00+09:00' });
    expect(target).toMatchObject({ found: true, url: 'https://meet.google.com/zzz-zzzz-zzz' });
    expect(target.series_id).toBeUndefined();
    expect(
      listUpcomingMeetings([edited], { now, from_min: 60, to_min: 75 })[0]?.series_id
    ).toBeUndefined();
  });

  it('lists joinable meetings in [from, to) minutes, earliest first', () => {
    const later = { ...weekly, title: 'Later', start: '2026-09-06T09:15:00+09:00' };
    const outside = { ...weekly, title: 'Outside', start: '2026-09-06T09:15:00.001+09:00' };
    const noLink = { title: 'No link', start: '2026-09-06T09:05:00+09:00', location: 'Room' };
    expect(
      listUpcomingMeetings([later, outside, noLink, weekly], { now, from_min: 60, to_min: 75 })
    ).toEqual([
      {
        title: 'Weekly Sync',
        url: 'https://meet.google.com/abc-defg-hij',
        platform: 'meet',
        series_id: 'series-weekly',
        start: '2026-09-06T09:10:00+09:00',
        end: '2026-09-06T09:40:00+09:00',
        starts_in_sec: 4200,
      },
    ]);
  });
});
