import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  setWorkCoordinationNamespace,
  updateWorkItem,
} from './work-coordination.js';
import { isCalendarDate } from '../foundation/time.js';
import { workItemScheduleCreation, workItemScheduleUpdate } from './work-item-schedule.js';

describe('work item schedule rules', () => {
  it('accepts only real calendar days', () => {
    expect(isCalendarDate('2026-11-30')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const value of [
      '2026-02-30',
      '2026-13-01',
      '2026-11-3',
      '2026-11-30T00:00:00Z',
      20261130,
      null,
    ]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  it('creates with optional dates and refuses start after due', () => {
    expect(workItemScheduleCreation({})).toEqual({});
    expect(workItemScheduleCreation({ dueDate: ' 2026-11-30 ' })).toEqual({
      due_date: '2026-11-30',
    });
    expect(() =>
      workItemScheduleCreation({ startDate: '2026-12-01', dueDate: '2026-11-30' })
    ).toThrow(/must not be after/);
    expect(() => workItemScheduleCreation({ dueDate: 'next friday' })).toThrow(/YYYY-MM-DD/);
    // A half-typed year from a date input is refused, not stored.
    expect(() => workItemScheduleCreation({ dueDate: '0002-11-30' })).toThrow(/between 1970/);
    expect(workItemScheduleCreation({ dueDate: '2999-12-31' })).toEqual({ due_date: '2999-12-31' });
  });

  it('keeps omitted dates, clears null, and checks the resulting pair', () => {
    const current = { start_date: '2026-11-20', due_date: '2026-11-30' };
    expect(workItemScheduleUpdate(current, {})).toEqual({});
    expect(workItemScheduleUpdate(current, { dueDate: '2026-12-05' })).toEqual({
      start_date: '2026-11-20',
      due_date: '2026-12-05',
    });
    expect(workItemScheduleUpdate(current, { startDate: null })).toEqual({
      start_date: undefined,
      due_date: '2026-11-30',
    });
    expect(() => workItemScheduleUpdate(current, { dueDate: '2026-11-19' })).toThrow(
      /must not be after/
    );
  });
});

describe('work item schedule through the store', () => {
  beforeEach(() => {
    setWorkCoordinationNamespace('work-item-schedule-test');
    clearWorkCoordinationStore();
  });

  afterEach(() => {
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
  });

  it('persists, changes and clears dates on a work item', () => {
    const created = createWorkItem({
      itemId: 'witem-schedule',
      title: 'Ship the calendar',
      description: 'Calendar tab',
      startDate: '2026-11-21',
      dueDate: '2026-11-30',
    });
    expect(created).toMatchObject({ start_date: '2026-11-21', due_date: '2026-11-30' });

    updateWorkItem({ itemId: created.item_id, expectedVersion: 1, dueDate: '2026-12-04' });
    expect(getWorkItem(created.item_id)).toMatchObject({
      start_date: '2026-11-21',
      due_date: '2026-12-04',
    });

    updateWorkItem({ itemId: created.item_id, startDate: null, dueDate: null });
    const cleared = getWorkItem(created.item_id)!;
    expect(cleared.start_date).toBeUndefined();
    expect(cleared.due_date).toBeUndefined();
  });

  it('refuses an invalid date without changing the item', () => {
    createWorkItem({ itemId: 'witem-bad-date', title: 't', description: 'd', status: 'ready' });
    expect(() =>
      updateWorkItem({ itemId: 'witem-bad-date', status: 'in_progress', dueDate: '2026-02-30' })
    ).toThrow(/YYYY-MM-DD/);
    expect(getWorkItem('witem-bad-date')).toMatchObject({ status: 'ready', version: 1 });
  });
});
