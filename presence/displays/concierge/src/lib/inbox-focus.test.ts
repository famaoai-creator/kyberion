import { describe, expect, it } from 'vitest';
import type { NeedsYouItem } from './needs-you-client';
import { selectInboxVisibleItems } from './inbox-focus';

const item = (id: string, overrides: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  reason: 'decision',
  title: { text: `Item ${id}` },
  requester: { label: { text: 'Agent' }, agent: true },
  overdue: false,
  actions: ['deny', 'allow_once', 'later'],
  group_size: 1,
  ...overrides,
  id,
});

describe('inbox-focus', () => {
  it('limits visible items to the top 3 prioritized items when focus mode is active and unfiltered', () => {
    const items = [
      item('k1', { reason: 'knowledge' }),
      item('o1', { reason: 'approval', overdue: true }),
      item('d1', { reason: 'decision', deadline: '2026-11-25T11:30:00Z' }),
      item('r1', { reason: 'review' }),
      item('b1', { reason: 'clarification', waiting_since: '2026-11-22T00:00:00Z' }),
    ];
    const selected = selectInboxVisibleItems(items, {
      focusMode: true,
      filtered: false,
      now: Date.parse('2026-11-25T10:00:00Z'),
    });
    expect(selected.visible).toHaveLength(3);
    expect(selected.visible.map((entry) => entry.id)).toEqual(['o1', 'd1', 'b1']);
    expect(selected.plan.total_items).toBe(5);
  });

  it('shows all items when focus mode is off or a filter is active', () => {
    const items = [item('a'), item('b'), item('c'), item('d')];
    expect(
      selectInboxVisibleItems(items, { focusMode: false, filtered: false }).visible
    ).toHaveLength(4);
    expect(
      selectInboxVisibleItems(items, { focusMode: true, filtered: true }).visible
    ).toHaveLength(4);
  });
});
