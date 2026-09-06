import { describe, expect, it } from 'vitest';
import { extractMeetingUrl, resolveNextMeetingTarget } from './meeting-target-resolve.js';

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
