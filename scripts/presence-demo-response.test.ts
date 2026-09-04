import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
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

  it('routes all presence demo output through the shared printer', () => {
    for (const file of [
      'scripts/presence/demo_presence_surface.ts',
      'scripts/presence/demo_presence_timeline.ts',
      'scripts/presence/demo_voice_hub_ingest.ts',
    ]) {
      const source = String(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }));
      expect(source).not.toContain('console.log');
      expect(source).not.toContain('console.error');
      expect(source).toContain('run: ({ print }) => main(print)');
    }
  });
});
