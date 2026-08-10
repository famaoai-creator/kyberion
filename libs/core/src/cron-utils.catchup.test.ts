import { describe, it, expect } from 'vitest';
import { hasMissedCronOccurrence, sameZonedMinute, matchesCron } from './cron-utils.js';

/**
 * EV-01: catch-up used to be private to pipeline-scheduler, so the generation
 * scheduler had no equivalent and every firing during a daemon outage was lost
 * permanently rather than merely late. Shared here so both schedulers make the
 * same promise; these are the properties both now rely on.
 */
describe('hasMissedCronOccurrence', () => {
  const at = (iso: string) => new Date(iso);

  it('停止中に過ぎた発火を検知する', () => {
    // Daily 03:00; last run yesterday 03:00; now 09:00 — 03:00 today was missed.
    expect(
      hasMissedCronOccurrence('0 3 * * *', at('2026-08-09T03:00:00Z'), at('2026-08-10T09:00:00Z'))
    ).toBe(true);
  });

  it('発火機会が無かった区間では false', () => {
    // Daily 03:00; last run today 03:00; now 09:00 — nothing due since.
    expect(
      hasMissedCronOccurrence('0 3 * * *', at('2026-08-10T03:00:00Z'), at('2026-08-10T09:00:00Z'))
    ).toBe(false);
  });

  it('lastRun より後の発火のみを数える（過去に遡らない）', () => {
    // now is before the day's 03:00, and lastRun is later still.
    expect(
      hasMissedCronOccurrence('0 3 * * *', at('2026-08-10T02:00:00Z'), at('2026-08-10T02:30:00Z'))
    ).toBe(false);
  });

  it('長期停止でも maxLookbackMinutes で走査が有界', () => {
    // A year of downtime must not become a year-long minute-by-minute loop.
    // With a 10-minute cap and an hourly cron, the walk cannot reach an
    // occurrence, so the bound is observable as a false.
    expect(
      hasMissedCronOccurrence(
        '0 3 * * *',
        at('2025-08-10T03:00:00Z'),
        at('2026-08-10T09:00:00Z'),
        undefined,
        10
      )
    ).toBe(false);
  });

  it('不正な lastRun では false（例外にしない）', () => {
    expect(
      hasMissedCronOccurrence('0 3 * * *', new Date('not-a-date'), at('2026-08-10T09:00:00Z'))
    ).toBe(false);
  });

  it('タイムゾーンを尊重する', () => {
    // 03:00 Asia/Tokyo on 2026-08-10 is 18:00Z on 2026-08-09.
    const cron = '0 3 * * *';
    expect(matchesCron(cron, at('2026-08-09T18:00:00Z'), 'Asia/Tokyo')).toBe(true);
    expect(
      hasMissedCronOccurrence(
        cron,
        at('2026-08-09T12:00:00Z'),
        at('2026-08-09T20:00:00Z'),
        'Asia/Tokyo'
      )
    ).toBe(true);
  });
});

describe('sameZonedMinute', () => {
  it('同一分は true、隣接分は false', () => {
    expect(
      sameZonedMinute(new Date('2026-08-10T03:00:10Z'), new Date('2026-08-10T03:00:50Z'))
    ).toBe(true);
    expect(
      sameZonedMinute(new Date('2026-08-10T03:00:59Z'), new Date('2026-08-10T03:01:00Z'))
    ).toBe(false);
  });
});
