import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  signature: 'missing' as string,
  reads: 0,
  items: [] as Array<{ item_id: string; mission_id: string; title: string; status: string }>,
}));

vi.mock('../meeting/action-item-store.js', () => ({
  actionItemStoreSignature: () => store.signature,
  listActionItems: () => {
    store.reads += 1;
    return store.items;
  },
}));

const { clearWorkspaceCalendarCache, defaultWorkspaceCalendarSources } =
  await import('./workspace-calendar.js');

describe('calendar action-item cache', () => {
  beforeEach(() => {
    clearWorkspaceCalendarCache();
    store.signature = 'missing';
    store.reads = 0;
    store.items = [];
  });

  it('reuses a list while the store is unchanged and re-reads as soon as it changes', () => {
    const sources = defaultWorkspaceCalendarSources();
    // No store yet: nothing to read.
    expect(sources.actionItems('MSN-1')).toEqual([]);
    expect(store.reads).toBe(0);

    store.signature = '100:10';
    store.items = [{ item_id: 'a', mission_id: 'MSN-1', title: 'First', status: 'pending' }];
    expect(sources.actionItems('MSN-1').map((item) => item.title)).toEqual(['First']);
    expect(sources.actionItems('MSN-1')).toHaveLength(1);
    expect(store.reads).toBe(1);

    // A write from any process changes the signature: the next read sees it.
    store.signature = '200:20';
    store.items = [
      ...store.items,
      { item_id: 'b', mission_id: 'MSN-1', title: 'Second', status: 'pending' },
    ];
    expect(sources.actionItems('MSN-1').map((item) => item.title)).toEqual(['First', 'Second']);
    expect(store.reads).toBe(2);
  });
});
