import { describe, expect, it } from 'vitest';
import { parsePresenceTimelineResponse } from './presence/demo_presence_timeline.js';
import { parseVoiceHubIngestResponse } from './presence/demo_voice_hub_ingest.js';

describe('presence demo response boundaries', () => {
  it('accepts safe object responses for both demos', () => {
    expect(parseVoiceHubIngestResponse({ ok: true, request_id: 'req-1' })).toEqual({
      ok: true,
      request_id: 'req-1',
    });
    expect(parsePresenceTimelineResponse({ ok: true, accepted: true })).toEqual({
      ok: true,
      accepted: true,
    });
  });

  it('rejects primitive, array, and dangerous responses before display', () => {
    for (const parse of [parseVoiceHubIngestResponse, parsePresenceTimelineResponse]) {
      expect(() => parse([])).toThrow('must be a JSON object');
      expect(() => parse('accepted')).toThrow('must be a JSON object');
      expect(() => parse({ result: { constructor: {} } })).toThrow('dangerous JSON key');
    }
  });
});
