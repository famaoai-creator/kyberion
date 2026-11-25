import { describe, expect, it } from 'vitest';
import { triageNeedsYouAttention } from './attention-triage.js';
import type { NeedsYouItem } from './needs-you.js';

const NOW = Date.parse('2026-11-25T10:00:00.000Z');

function makeItem(overrides: Partial<NeedsYouItem> & { id: string }): NeedsYouItem {
  return {
    reason: 'approval',
    title: { text: overrides.id },
    requester: { label: { text: 'Agent' }, agent: true },
    overdue: false,
    actions: ['deny', 'allow_once', 'later'],
    group_size: 1,
    ...overrides,
  };
}

describe('attention-triage', () => {
  it('prioritizes overdue, imminent deadlines, high risk, and grouped approvals into Focus Top 3', () => {
    const items: NeedsYouItem[] = [
      makeItem({
        id: 'k1',
        reason: 'knowledge',
        waiting_since: '2026-11-25T09:00:00.000Z',
      }),
      makeItem({
        id: 'r1',
        reason: 'review',
        waiting_since: '2026-11-24T00:00:00.000Z',
      }),
      makeItem({
        id: 'a-overdue',
        reason: 'approval',
        overdue: true,
        group_size: 4,
        waiting_since: '2026-11-20T00:00:00.000Z',
      }),
      makeItem({
        id: 'a-imminent',
        reason: 'approval',
        deadline: '2026-11-25T12:00:00.000Z',
        approval: {
          id: 'req-2',
          channel: 'autonomy',
          storage_channel: 'autonomy',
          title: 'PR merge',
          reason: 'low risk',
          requested_at: '2026-11-25T08:00:00.000Z',
          brief: {
            ask: { text: 'Merge PR' },
            why: [],
            onApprove: { text: 'Merges' },
            onReject: { text: 'Stops' },
            ifSilent: { text: 'Waits' },
            requester: { text: 'Agent' },
            state: 'pending',
            groupKey: 'g2',
            details: [],
            risk: 'high',
          },
        },
      }),
      makeItem({
        id: 'c1',
        reason: 'clarification',
        waiting_since: '2026-11-22T00:00:00.000Z',
      }),
    ];

    const plan = triageNeedsYouAttention(items, { now: NOW, focusLimit: 3 });

    expect(plan.total_items).toBe(5);
    expect(plan.total_underlying_records).toBe(8);
    expect(plan.focus.map((entry) => entry.item.id)).toEqual(['a-overdue', 'a-imminent', 'c1']);
    expect(plan.focus_clears_records).toBe(6);
    expect(plan.now_items.map((entry) => entry.item.id)).toEqual(['a-overdue', 'a-imminent']);
    expect(plan.today_items.map((entry) => entry.item.id)).toEqual(['c1']);
    expect(plan.batch_items.map((entry) => entry.item.id)).toEqual(['r1', 'k1']);
    expect(plan.estimated_focus_minutes).toBeGreaterThan(0);
    expect(plan.estimated_total_minutes).toBeGreaterThanOrEqual(plan.estimated_focus_minutes);
  });

  it('handles empty queues deterministically', () => {
    const plan = triageNeedsYouAttention([], { now: NOW });
    expect(plan).toEqual({
      focus: [],
      now_items: [],
      today_items: [],
      batch_items: [],
      all_items: [],
      total_items: 0,
      total_underlying_records: 0,
      focus_clears_records: 0,
      estimated_total_minutes: 0,
      estimated_focus_minutes: 0,
    });
  });
});
