import { describe, expect, it, vi } from 'vitest';

const infoMock = vi.hoisted(() => vi.fn());

vi.mock('./core.js', () => ({
  logger: {
    info: infoMock,
  },
}));

import {
  formatCalendarAgendaReply,
  parseSurfaceWeatherForecastResponse,
  parseSurfaceWeatherGeocodeResponse,
  resolvedSurfaceIntent,
} from './surface-query-helpers.js';

describe('surface-query-helpers', () => {
  it('logs omitted agenda events when the reply is truncated', () => {
    const result = formatCalendarAgendaReply({
      sourceLabel: 'browser_calendar',
      sourceName: 'Work',
      rangeLabel: 'today',
      events: Array.from({ length: 12 }, (_, index) => ({
        title: `Event ${index + 1}`,
        start: '2026-07-03T09:00:00.000Z',
        end: '2026-07-03T09:30:00.000Z',
        calendar: 'Work',
      })),
    });

    expect(result.omitted_count).toBe(2);
    expect(infoMock).toHaveBeenCalledWith(
      '[surface-query-helpers] omitted 2 agenda event(s) for browser_calendar / Work today'
    );
  });

  it('reuses the route packet instead of resolving thread context again', () => {
    const resolved = resolvedSurfaceIntent({
      input: {
        surfaceText: 'show the current status',
        threadContext: 'User: search the web for current status',
        scope: { tier: 'public', tenant_slug: 'tenant-a' },
      },
      resolutionPacket: {
        kind: 'intent_resolution_packet',
        utterance: 'show the current status',
        selected_intent_id: 'knowledge-query',
        selected_confidence: 0.95,
        selected_resolution: { shape: 'direct_reply' },
        candidates: [],
      },
    });

    expect(resolved.intentId).toBe('knowledge-query');
    expect(resolved.queryType).toBe('knowledge_search');
  });

  it('keeps only finite weather coordinates and scalar current values', () => {
    expect(
      parseSurfaceWeatherGeocodeResponse({
        results: [
          { latitude: '35.6', longitude: 139.6, name: { text: 'Tokyo' } },
          { latitude: 35.6, longitude: 139.6, name: 'Tokyo' },
        ],
      })
    ).toEqual([{ latitude: 35.6, longitude: 139.6, name: 'Tokyo' }]);
    expect(parseSurfaceWeatherGeocodeResponse([])).toBeUndefined();
    expect(
      parseSurfaceWeatherForecastResponse({
        current: {
          temperature_2m: 18.5,
          weather_code: { value: 2 },
          wind_speed_10m: 4.2,
          relative_humidity_2m: '62',
        },
      })
    ).toEqual({ current: { temperature_2m: 18.5, wind_speed_10m: 4.2 } });
    expect(parseSurfaceWeatherForecastResponse({ current: [] })).toBeUndefined();
  });
});
