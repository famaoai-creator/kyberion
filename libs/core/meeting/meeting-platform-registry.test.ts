import { describe, expect, it } from 'vitest';
import {
  defaultSelectorMeetingPlatform,
  findMeetingPlatformByProvider,
  getMeetingPlatform,
  listMeetingPlatforms,
  resolveMeetingPlatformByHost,
  resolveMeetingSelectorList,
} from './meeting-platform-registry.js';
import { resolveMeetingPlatformFromUrl, validateMeetingTarget } from './meeting-join-driver.js';

describe('meeting platform registry (RS-06)', () => {
  it('registers the joinable platforms with hosts and selectors', () => {
    const ids = listMeetingPlatforms().map((platform) => platform.id);
    expect(ids).toEqual(expect.arrayContaining(['meet', 'zoom', 'teams']));
    expect(defaultSelectorMeetingPlatform().id).toBe('meet');
    for (const platform of listMeetingPlatforms()) {
      expect(platform.hosts.length).toBeGreaterThan(0);
      expect(Object.keys(platform.pre_join_selectors)).toContain('join_button');
      expect(Object.keys(platform.in_meeting_selectors)).toContain('captions_container');
    }
  });

  it('fails closed for an unknown platform', () => {
    expect(() => getMeetingPlatform('webex')).toThrow(/unknown meeting platform "webex"/);
  });

  it('resolves provider aliases to platforms', () => {
    expect(findMeetingPlatformByProvider('google_meet')?.id).toBe('meet');
    expect(findMeetingPlatformByProvider('teams_pipeline')?.id).toBe('teams');
    expect(findMeetingPlatformByProvider('webex')).toBeUndefined();
  });

  it('applies the data-declared entry-path restriction for broad hosts', () => {
    expect(resolveMeetingPlatformByHost('microsoft.com', '/en-us/')).toBeNull();
    expect(
      resolveMeetingPlatformByHost('www.microsoft.com', '/microsoft-teams/join-a-meeting')?.id
    ).toBe('teams');
    expect(resolveMeetingPlatformByHost('teams.microsoft.com', '/l/meetup-join/x')?.id).toBe(
      'teams'
    );
    expect(resolveMeetingPlatformFromUrl('https://us02web.zoom.us/j/1')).toBe('zoom');
    expect(() =>
      validateMeetingTarget({ platform: 'teams', url: 'https://microsoft.com/en-us/' })
    ).toThrow(/join-a-meeting/);
    expect(
      validateMeetingTarget({
        platform: 'teams',
        url: 'https://microsoft.com/microsoft-teams/join-a-meeting',
      }).platform
    ).toBe('teams');
  });

  it('keeps selector order and can restrict localized labels by locale', () => {
    const entries = ['a', { selector: 'b', locale: 'en' }, { selector: 'c', locale: 'ja' }, 'd'];
    expect(resolveMeetingSelectorList(entries)).toEqual(['a', 'b', 'c', 'd']);
    expect(resolveMeetingSelectorList(entries, { locales: ['ja'] })).toEqual(['a', 'c', 'd']);
  });
});
