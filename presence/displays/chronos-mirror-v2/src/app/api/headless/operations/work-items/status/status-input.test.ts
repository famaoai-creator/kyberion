import { describe, expect, it } from 'vitest';
import { parseHeadlessWorkItemStatusInput } from './status-input';

describe('parseHeadlessWorkItemStatusInput', () => {
  it('normalizes a strict status update body', () => {
    expect(
      parseHeadlessWorkItemStatusInput({ item_id: ' work-item-1 ', status: 'in_progress' })
    ).toEqual({ item_id: 'work-item-1', status: 'in_progress' });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing item id', { status: 'done' }],
    ['non-string item id', { item_id: { value: 'work-item-1' }, status: 'done' }],
    ['unsafe item id', { item_id: '../work-item-1', status: 'done' }],
    ['invalid status', { item_id: 'work-item-1', status: 'running' }],
    ['unknown field', { item_id: 'work-item-1', status: 'done', force: true }],
  ])('rejects %s before the work-item mutation', (_label, value) => {
    expect(() => parseHeadlessWorkItemStatusInput(value)).toThrow();
  });

  it('rejects oversized identifiers and non-string statuses', () => {
    expect(() =>
      parseHeadlessWorkItemStatusInput({ item_id: `work-${'x'.repeat(252)}`, status: 'done' })
    ).toThrow();
    expect(() =>
      parseHeadlessWorkItemStatusInput({ item_id: 'work-item-1', status: ['done'] })
    ).toThrow();
  });
});
