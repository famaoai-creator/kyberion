import { describe, expect, it } from 'vitest';
import {
  URGENT_PRESET_EVENTS,
  isValidQuietHoursInput,
  parseQuietHoursResponse,
  presetFromUrgentEvents,
  matchesQuietHoursPreferences,
} from '../src/lib/quiet-hours-view';
const window = { start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' };
const prefs = { quiet_hours: window, urgent_events: ['ops_alert'] };
describe('quiet-hours form and receipt helpers', () => {
  it('accepts an overnight window and rejects malformed or empty input', () => {
    expect(isValidQuietHoursInput(window)).toBe(true);
    for (const patch of [
      { start: '25:00' },
      { end: '7:00' },
      { end: '22:00' },
      { timezone: ' ' },
      { timezone: 'Asia Tokyo' },
    ])
      expect(isValidQuietHoursInput({ ...window, ...patch })).toBe(false);
  });
  it('round-trips presets and explicitly preserves custom event selections', () => {
    for (const [preset, events] of Object.entries(URGENT_PRESET_EVENTS))
      expect(presetFromUrgentEvents([...events].reverse())).toBe(preset);
    expect(presetFromUrgentEvents(['mission_completed'])).toBe('custom');
    expect(presetFromUrgentEvents([])).toBe('custom');
  });
  it('accepts complete on/off receipts and an empty urgent-event list', () => {
    expect(parseQuietHoursResponse({ ok: true, preferences: prefs })).toEqual(prefs);
    expect(
      parseQuietHoursResponse({ ok: true, preferences: { quiet_hours: null, urgent_events: [] } })
    ).toEqual({ quiet_hours: null, urgent_events: [] });
  });
  it.each([
    null,
    [],
    { ok: false },
    { ok: true, preferences: [] },
    { ok: true, preferences: {} },
    { ok: true, preferences: { quiet_hours: null } },
    { ok: true, preferences: { urgent_events: [] } },
    ...[
      { quiet_hours: [] },
      { quiet_hours: { ...window, start: '25:00' } },
      { quiet_hours: { ...window, timezone: 'Not/AZone' } },
      { urgent_events: null },
      { urgent_events: [1] },
      { urgent_events: [''] },
    ].map((patch) => ({ ok: true, preferences: { ...prefs, ...patch } })),
  ])('rejects malformed receipt %#', (value) => {
    expect(parseQuietHoursResponse(value)).toBeUndefined();
  });
  it('matches the submitted snapshot, comparing urgent events as a set', () => {
    expect(matchesQuietHoursPreferences(prefs, prefs)).toBe(true);
    expect(
      matchesQuietHoursPreferences({ ...prefs, urgent_events: ['ops_alert', 'ops_alert'] }, prefs)
    ).toBe(true);
    for (const patch of [
      { quiet_hours: null },
      { quiet_hours: { ...window, end: '08:00' } },
      { quiet_hours: { ...window, timezone: 'UTC' } },
      { urgent_events: [] },
    ])
      expect(matchesQuietHoursPreferences({ ...prefs, ...patch }, prefs)).toBe(false);
  });
});
