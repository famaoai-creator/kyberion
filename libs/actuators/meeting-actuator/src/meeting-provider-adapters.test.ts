import { describe, expect, it } from 'vitest';
import { resolveMeetingProvider } from './meeting-provider-adapters.js';

describe('meeting provider adapters', () => {
  it('resolves supported providers from URLs', () => {
    expect(resolveMeetingProvider('auto', 'https://us02web.zoom.us/j/123')?.id).toBe('zoom');
    expect(
      resolveMeetingProvider('auto', 'https://teams.microsoft.com/l/meetup-join/abc')?.id
    ).toBe('teams');
    expect(resolveMeetingProvider('auto', 'https://meet.google.com/abc-defg-hij')?.id).toBe(
      'google_meet'
    );
  });

  it('honors an explicit provider even without a URL', () => {
    expect(resolveMeetingProvider('teams_pipeline', undefined)?.id).toBe('teams');
    expect(resolveMeetingProvider('google_meet', undefined)?.id).toBe('google_meet');
  });

  it('returns undefined for unknown hosts', () => {
    expect(resolveMeetingProvider('auto', 'https://example.com/meeting')).toBeUndefined();
  });
});
