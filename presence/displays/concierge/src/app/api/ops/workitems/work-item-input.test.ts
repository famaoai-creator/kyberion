import { describe, expect, it } from 'vitest';
import {
  parseWorkItemActionInput,
  parseWorkItemScheduleInput,
  parseWorkItemStatusInput,
} from './work-item-input';

describe('parseWorkItemStatusInput', () => {
  it('normalizes a strict status update body', () => {
    expect(parseWorkItemStatusInput({ itemId: ' work-item-1 ', status: 'in_progress' })).toEqual({
      itemId: 'work-item-1',
      status: 'in_progress',
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing item id', { status: 'done' }],
    ['non-string item id', { itemId: { value: 'work-item-1' }, status: 'done' }],
    ['unsafe item id', { itemId: '../work-item-1', status: 'done' }],
    ['invalid status', { itemId: 'work-item-1', status: 'running' }],
    ['unknown field', { itemId: 'work-item-1', status: 'done', force: true }],
  ])('rejects %s before the work-item mutation', (_label, value) => {
    expect(() => parseWorkItemStatusInput(value)).toThrow();
  });

  it('rejects oversized identifiers and non-string statuses', () => {
    expect(() =>
      parseWorkItemStatusInput({ itemId: `work-${'x'.repeat(252)}`, status: 'done' })
    ).toThrow();
    expect(() => parseWorkItemStatusInput({ itemId: 'work-item-1', status: ['done'] })).toThrow();
  });
});

describe('parseWorkItemScheduleInput', () => {
  it('sets, clears and keeps dates', () => {
    expect(parseWorkItemScheduleInput({ itemId: 'w-1', dueDate: '2026-11-30' })).toEqual({
      itemId: 'w-1',
      dueDate: '2026-11-30',
    });
    expect(parseWorkItemScheduleInput({ itemId: 'w-1', startDate: null, dueDate: null })).toEqual({
      itemId: 'w-1',
      startDate: null,
      dueDate: null,
    });
  });

  it.each([
    ['no date', { itemId: 'w-1' }],
    ['timestamp', { itemId: 'w-1', dueDate: '2026-11-30T09:00:00Z' }],
    ['non-string date', { itemId: 'w-1', dueDate: 20261130 }],
    ['status mixed in', { itemId: 'w-1', dueDate: '2026-11-30', status: 'done' }],
    ['client scope', { itemId: 'w-1', dueDate: '2026-11-30', tenant: 'acme' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseWorkItemScheduleInput(value)).toThrow();
  });

  it('is chosen by the action parser only when a date field is present', () => {
    expect(parseWorkItemActionInput({ itemId: 'w-1', dueDate: '2026-11-30' })).toEqual({
      itemId: 'w-1',
      dueDate: '2026-11-30',
    });
    expect(parseWorkItemActionInput({ itemId: 'w-1', status: 'done' })).toEqual({
      itemId: 'w-1',
      status: 'done',
    });
  });
});
