import { describe, expect, it } from 'vitest';
import { LOCAL_EVENT_BUS_ID, getEventBus, resolveEventBus } from './event-bus.js';
import './local-event-bus.js';
import { MEMORY_EVENT_BUS_ID, createMemoryEventBus } from './memory-event-bus.js';

describe('event-bus seam', () => {
  it('resolves the governed default to local-process', () => {
    expect(resolveEventBus().id).toBe(LOCAL_EVENT_BUS_ID);
  });

  it('keeps memory out of the default chain (registered but never auto-selected)', () => {
    expect(getEventBus(MEMORY_EVENT_BUS_ID)).toBeDefined();
    expect(resolveEventBus().id).toBe(LOCAL_EVENT_BUS_ID);
  });

  it('resolves an explicit selector over the default', () => {
    expect(resolveEventBus(MEMORY_EVENT_BUS_ID).id).toBe(MEMORY_EVENT_BUS_ID);
  });

  it('throws for an unknown selector', () => {
    expect(() => resolveEventBus('no-such-bus')).toThrow(/unknown bus 'no-such-bus'/);
  });
});

describe('memory event bus delivery', () => {
  it('delivers publish to matching subscribers', async () => {
    const bus = createMemoryEventBus();
    const received: unknown[] = [];
    bus.subscribe('mission.checkpoint', (msg) => {
      received.push(msg.payload);
    });
    await bus.publish('mission.checkpoint', { id: 'm1' });
    expect(received).toEqual([{ id: 'm1' }]);
  });

  it('stops delivery after unsubscribe', async () => {
    const bus = createMemoryEventBus();
    const received: unknown[] = [];
    const unsubscribe = bus.subscribe('mission.finish', (msg) => {
      received.push(msg.payload);
    });
    await bus.publish('mission.finish', 'first');
    unsubscribe();
    await bus.publish('mission.finish', 'second');
    expect(received).toEqual(['first']);
  });

  it('awaits async handlers and stamps published_at_ms', async () => {
    const bus = createMemoryEventBus({ id: 'isolated' });
    expect(bus.id).toBe('isolated');
    let seenAt = 0;
    bus.subscribe('tick', async (msg) => {
      await Promise.resolve();
      seenAt = msg.published_at_ms;
    });
    const before = Date.now();
    await bus.publish('tick', null);
    expect(seenAt).toBeGreaterThanOrEqual(before);
  });
});
