import { describe, expect, it } from 'vitest';
import { parseWorkItemStatusInput } from './work-item-input';

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
