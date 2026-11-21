import { describe, expect, it } from 'vitest';
import { dueState } from '../work-board/work-item-board';
import {
  addMonths,
  buildCalendarGrid,
  localCalendarDate,
  shiftAnchor,
  startOfWeek,
  summarizeCalendar,
  type CalendarItem,
} from './work-calendar';

const TODAY = '2026-11-21'; // a Saturday

describe('dueState', () => {
  it.each([
    ['2026-11-19', 'in_progress', 'overdue', -2],
    ['2026-11-21', 'ready', 'due_today', 0],
    ['2026-11-23', 'backlog', 'due_soon', 2],
    ['2026-11-24', 'blocked', 'upcoming', 3],
    ['2026-11-01', 'done', 'done', -20],
    ['2026-11-01', 'archived', 'done', -20],
  ])('%s while %s is %s', (due, status, state, days) => {
    expect(dueState(due, status, TODAY)).toEqual({ state, days });
  });

  it('has no state without a valid date', () => {
    expect(dueState(undefined, 'ready', TODAY)).toEqual({ state: 'none' });
    expect(dueState('soon', 'ready', TODAY)).toEqual({ state: 'none' });
  });

  it('counts calendar days across a month end and DST-free', () => {
    expect(dueState('2026-12-01', 'ready', '2026-11-30').days).toBe(1);
    expect(dueState('2027-03-29', 'ready', '2027-03-27').days).toBe(2);
  });
});

describe('calendar arithmetic', () => {
  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-11-21')).toBe('2026-11-16');
    expect(startOfWeek('2026-11-16')).toBe('2026-11-16');
    expect(startOfWeek('2026-11-22')).toBe('2026-11-16');
  });

  it('clamps month steps to the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(shiftAnchor('2026-11-21', 'week', -1)).toBe('2026-11-14');
  });

  it('reads the local day, not the UTC day', () => {
    expect(localCalendarDate(new Date(2026, 10, 21, 23, 59))).toBe('2026-11-21');
  });
});

const items: CalendarItem[] = [
  { id: 'late', title: 'Late report', status: 'in_progress', dueDate: '2026-11-19' },
  { id: 'today', title: 'Ship today', status: 'ready', dueDate: '2026-11-21' },
  {
    id: 'span',
    title: 'Migration',
    status: 'in_progress',
    startDate: '2026-11-17',
    dueDate: '2026-11-20',
  },
  { id: 'done', title: 'Old task', status: 'done', dueDate: '2026-11-18' },
  { id: 'next-month', title: 'December', status: 'backlog', dueDate: '2026-12-02' },
  { id: 'undated', title: 'No date', status: 'backlog' },
];

describe('buildCalendarGrid', () => {
  it('covers the month in whole Monday-first weeks', () => {
    const grid = buildCalendarGrid(items, { view: 'month', anchor: TODAY, today: TODAY });
    expect(grid.from).toBe('2026-10-26');
    expect(grid.to).toBe('2026-12-06');
    expect(grid.weeks).toHaveLength(6);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    const day = (date: string) => grid.weeks.flat().find((entry) => entry.date === date)!;
    expect(day('2026-10-26').inRange).toBe(false);
    expect(day('2026-11-21')).toMatchObject({ isToday: true, isWeekend: true });
    expect(day('2026-12-02').entries.map((entry) => entry.item.id)).toEqual(['next-month']);
  });

  it('places due and start days in a month, and the days between only in a week', () => {
    const month = buildCalendarGrid(items, { view: 'month', anchor: TODAY, today: TODAY });
    const monthDay = (date: string) => month.weeks.flat().find((entry) => entry.date === date)!;
    expect(monthDay('2026-11-17').entries.map((entry) => entry.role)).toEqual(['start']);
    expect(monthDay('2026-11-18').entries.map((entry) => entry.item.id)).toEqual(['done']);

    const week = buildCalendarGrid(items, { view: 'week', anchor: TODAY, today: TODAY });
    expect(week.weeks).toHaveLength(1);
    const weekDay = (date: string) => week.weeks[0].find((entry) => entry.date === date)!;
    expect(weekDay('2026-11-18').entries.map((entry) => [entry.item.id, entry.role])).toEqual([
      ['done', 'due'],
      ['span', 'span'],
    ]);
    expect(weekDay('2026-11-19').entries[0]).toMatchObject({
      item: { id: 'late' },
      role: 'due',
      due: { state: 'overdue' },
    });
  });

  it('never lists an undated item', () => {
    const grid = buildCalendarGrid(items, { view: 'month', anchor: TODAY, today: TODAY });
    expect(
      grid.weeks.flat().some((day) => day.entries.some((entry) => entry.item.id === 'undated'))
    ).toBe(false);
  });
});

describe('summarizeCalendar', () => {
  it('lists open overdue and due-soon items, oldest first', () => {
    const summary = summarizeCalendar(items, TODAY);
    expect(summary.overdue.map((item) => item.id)).toEqual(['late', 'span']);
    expect(summary.dueSoon.map((item) => item.id)).toEqual(['today']);
  });
});
