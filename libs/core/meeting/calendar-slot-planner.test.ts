import { describe, expect, it } from 'vitest';
import { planAvailableSlots } from './calendar-slot-planner.js';

describe('calendar slot planner', () => {
  it('skips busy windows and Japanese bank holidays', () => {
    const slots = planAvailableSlots({
      range_start: '2026-10-01T00:00:00.000Z',
      range_end: '2026-10-03T00:00:00.000Z',
      duration_minutes: 60,
      slot_step_minutes: 60,
      timezone: 'Asia/Tokyo',
      business_calendar: 'japanese_bank',
      working_hours: { start: '09:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] },
      busy: [{ start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T01:00:00.000Z' }],
    });
    expect(slots).toEqual([
      {
        start: '2026-10-01T01:00:00.000Z',
        end: '2026-10-01T02:00:00.000Z',
        timezone: 'Asia/Tokyo',
      },
      {
        start: '2026-10-01T02:00:00.000Z',
        end: '2026-10-01T03:00:00.000Z',
        timezone: 'Asia/Tokyo',
      },
      {
        start: '2026-10-02T00:00:00.000Z',
        end: '2026-10-02T01:00:00.000Z',
        timezone: 'Asia/Tokyo',
      },
      {
        start: '2026-10-02T01:00:00.000Z',
        end: '2026-10-02T02:00:00.000Z',
        timezone: 'Asia/Tokyo',
      },
      {
        start: '2026-10-02T02:00:00.000Z',
        end: '2026-10-02T03:00:00.000Z',
        timezone: 'Asia/Tokyo',
      },
    ]);
  });
});
