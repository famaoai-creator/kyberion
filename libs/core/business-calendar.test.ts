import { describe, expect, it } from 'vitest';
import {
  isJapaneseBankBusinessDay,
  japaneseNationalHolidays,
  nthBusinessDayOfMonth,
  nthBusinessDayOfMonthClamped,
  zonedWallTimeToInstant,
} from './business-calendar.js';

describe('Japanese bank business-day calendar', () => {
  it('derives the 2026 national holidays, including substitute and citizen holidays', () => {
    expect([...japaneseNationalHolidays(2026)].sort()).toEqual(
      [
        '1-1',
        '1-12',
        '2-11',
        '2-23',
        '3-20',
        '4-29',
        '5-3',
        '5-4',
        '5-5',
        '5-6', // substitute for Sunday 5/3
        '7-20',
        '8-11',
        '9-21',
        '9-22', // citizen's holiday between Respect-for-the-Aged Day and the equinox
        '9-23',
        '10-12',
        '11-3',
        '11-23',
      ].sort()
    );
  });

  it('moves Sunday holidays to the next weekday', () => {
    expect(japaneseNationalHolidays(2025).has('11-24')).toBe(true);
    expect(japaneseNationalHolidays(2024).has('2-12')).toBe(true);
    expect(japaneseNationalHolidays(2024).has('9-23')).toBe(true);
  });

  it('treats weekends, holidays and Dec 31 – Jan 3 as bank closing days', () => {
    expect(isJapaneseBankBusinessDay({ year: 2026, month: 10, day: 2 })).toBe(true);
    expect(isJapaneseBankBusinessDay({ year: 2026, month: 10, day: 3 })).toBe(false);
    expect(isJapaneseBankBusinessDay({ year: 2026, month: 11, day: 3 })).toBe(false);
    expect(isJapaneseBankBusinessDay({ year: 2026, month: 12, day: 31 })).toBe(false);
    expect(isJapaneseBankBusinessDay({ year: 2027, month: 1, day: 3 })).toBe(false);
  });

  it('finds the nth business day of a month', () => {
    expect(nthBusinessDayOfMonth(2026, 10, 2)).toEqual({ year: 2026, month: 10, day: 2 });
    expect(nthBusinessDayOfMonth(2026, 11, 2)).toEqual({ year: 2026, month: 11, day: 4 });
    expect(nthBusinessDayOfMonth(2027, 1, 2)).toEqual({ year: 2027, month: 1, day: 5 });
    expect(nthBusinessDayOfMonth(2026, 5, 1)).toEqual({ year: 2026, month: 5, day: 1 });
    expect(nthBusinessDayOfMonth(2026, 2, 25)).toBeUndefined();
  });

  it('clamps the nth business day to the last business day of a short month', () => {
    expect(nthBusinessDayOfMonthClamped(2027, 2, 23)).toEqual({ year: 2027, month: 2, day: 26 });
    expect(nthBusinessDayOfMonthClamped(2026, 10, 2)).toEqual({ year: 2026, month: 10, day: 2 });
  });

  it('converts a Tokyo wall-clock time to its UTC instant', () => {
    expect(
      zonedWallTimeToInstant({ year: 2026, month: 10, day: 2 }, '17:00', 'Asia/Tokyo').toISOString()
    ).toBe('2026-10-02T08:00:00.000Z');
  });

  it('refuses years outside the supported range', () => {
    expect(() => japaneseNationalHolidays(2019)).toThrow(/supports/);
  });
});
