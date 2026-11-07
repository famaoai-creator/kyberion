import { describe, expect, it } from 'vitest';
import { resolveTemporalContext, resolveTemporalWindow } from './temporal-context.js';

describe('temporal context', () => {
  it('resolves a Japanese bank business-day window in the requested timezone', () => {
    const result = resolveTemporalWindow(
      { business_day: 2, wall_time: '09:00', duration_minutes: 45 },
      {
        now: '2026-10-01T00:00:00Z',
        timezone: 'Asia/Tokyo',
        business_calendar: 'japanese_bank',
      }
    );
    expect(result.resolved_from).toBe('business_day');
    expect(result.start.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(result.end.toISOString()).toBe('2026-10-02T00:45:00.000Z');
  });

  it('validates working hours and timezone before a calendar adapter is called', () => {
    expect(() => resolveTemporalContext({ timezone: 'not/a-zone' })).toThrow(/invalid timezone/);
    expect(() =>
      resolveTemporalContext({
        timezone: 'Asia/Tokyo',
        working_hours: { start: '18:00', end: '09:00' },
      })
    ).toThrow(/working_hours.start/);
  });
});
