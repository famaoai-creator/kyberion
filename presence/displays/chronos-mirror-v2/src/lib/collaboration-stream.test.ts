import { describe, expect, it, vi } from 'vitest';
import { CollaborationEventBatcher, collaborationEventVisibleToTier } from './collaboration-stream';

describe('collaboration stream batching', () => {
  it('uses embedded scope tier and rejects unknown legacy tier', () => {
    expect(
      collaborationEventVisibleToTier(
        { scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' } },
        'confidential',
        ['public']
      )
    ).toBe(false);
    expect(
      collaborationEventVisibleToTier(
        { scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' } },
        'confidential',
        ['public']
      )
    ).toBe(false);
    expect(
      collaborationEventVisibleToTier(
        { scope: { scope_kind: 'tenant', tier: 'public', tenant_slug: 'tenant-a' } },
        undefined,
        ['public']
      )
    ).toBe(true);
    expect(collaborationEventVisibleToTier({}, undefined, ['public', 'confidential'])).toBe(false);
  });

  it('emits the first event immediately and batches the rest by type', () => {
    vi.useFakeTimers();
    const emitted: string[][] = [];
    const batcher = new CollaborationEventBatcher((events) =>
      emitted.push(events.map((event) => event.id))
    );
    const event = (id: string) => ({ id, type: 'status_update', ts: id, payload: {} });
    batcher.push(event('a'));
    batcher.push(event('b'));
    batcher.push(event('c'));
    expect(emitted).toEqual([['a']]);
    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([['a'], ['b', 'c']]);
    vi.useRealTimers();
  });

  it('sheds the oldest event at the bounded queue boundary', () => {
    const emitted: string[][] = [];
    const batcher = new CollaborationEventBatcher((events) =>
      emitted.push(events.map((event) => event.id))
    );
    const first = { id: 'first', type: 'custom', ts: '', payload: {} };
    batcher.push(first);
    for (let i = 0; i < 80; i += 1) batcher.push({ ...first, id: `e-${i}` });
    batcher.flush();
    expect(emitted[1]?.[0]).toBe('e-20');
  });
});
