import { describe, expect, it, vi } from 'vitest';

const infoMock = vi.hoisted(() => vi.fn());

vi.mock('./core.js', () => ({
  logger: {
    info: infoMock,
  },
}));

import { formatCalendarAgendaReply } from './surface-query-helpers.js';

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
});
