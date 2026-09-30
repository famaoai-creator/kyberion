import { describe, expect, it } from 'vitest';
import {
  URGENT_PRESET_EVENTS,
  isValidQuietHoursInput,
  parseQuietHoursResponse,
  presetFromUrgentEvents,
} from '../src/lib/quiet-hours-view';

describe('isValidQuietHoursInput', () => {
  const ok = { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' };
  it('accepts a midnight-wrapping window', () => expect(isValidQuietHoursInput(ok)).toBe(true));
  it('rejects malformed times, an empty window and a blank/spaced timezone', () => {
    expect(isValidQuietHoursInput({ ...ok, start: '25:00' })).toBe(false);
    expect(isValidQuietHoursInput({ ...ok, end: '7:00' })).toBe(false);
    expect(isValidQuietHoursInput({ ...ok, end: '22:00' })).toBe(false);
    expect(isValidQuietHoursInput({ ...ok, timezone: ' ' })).toBe(false);
    expect(isValidQuietHoursInput({ ...ok, timezone: 'Asia Tokyo' })).toBe(false);
  });
});

describe('urgent presets', () => {
  it('round-trips every preset and falls back to the safest for unknown lists', () => {
    for (const [preset, events] of Object.entries(URGENT_PRESET_EVENTS)) {
      expect(presetFromUrgentEvents([...events].reverse())).toBe(preset);
    }
    expect(presetFromUrgentEvents(['mission_completed'])).toBe('alerts_only');
    expect(presetFromUrgentEvents([])).toBe('alerts_only');
  });
});

describe('parseQuietHoursResponse', () => {
  it('parses a saved window and defaults urgent events', () => {
    expect(
      parseQuietHoursResponse({
        ok: true,
        preferences: { quiet_hours: { start: '22:00', end: '07:00', timezone: 'UTC' } },
      })
    ).toEqual({
      quiet_hours: { start: '22:00', end: '07:00', timezone: 'UTC' },
      urgent_events: ['ops_alert'],
    });
  });
  it('treats null as "off" and rejects malformed payloads', () => {
    expect(
      parseQuietHoursResponse({ ok: true, preferences: { quiet_hours: null } })?.quiet_hours
    ).toBeNull();
    expect(parseQuietHoursResponse({ ok: false })).toBeUndefined();
    expect(
      parseQuietHoursResponse({ ok: true, preferences: { quiet_hours: { start: 1 } } })
    ).toBeUndefined();
    expect(parseQuietHoursResponse(null)).toBeUndefined();
  });
});
