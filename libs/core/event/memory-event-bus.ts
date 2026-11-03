/**
 * memory event bus — hermetic in-process pub/sub for tests and dry runs.
 *
 * `createMemoryEventBus({ id })` returns an isolated subscriber map. Importing
 * this module also registers one shared `memory` provider on the seam so
 * `resolveEventBus('memory')` works — it is never in the governed default
 * chain. The governed default (`local-process`) uses the same factory with a
 * distinct id for selection-policy clarity.
 */

import { registerEventBus, type EventBus, type EventBusMessage } from './event-bus.js';

export const MEMORY_EVENT_BUS_ID = 'memory';

type EventHandler = (msg: EventBusMessage) => void | Promise<void>;

class MemoryEventBus implements EventBus {
  readonly id: string;
  private readonly topics = new Map<string, Set<EventHandler>>();

  constructor(id: string) {
    this.id = id;
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const handlers = this.topics.get(topic);
    if (!handlers || handlers.size === 0) return;
    const message: EventBusMessage = {
      topic,
      payload,
      published_at_ms: Date.now(),
    };
    // Snapshot so unsubscribe during delivery does not skip/double-fire.
    for (const handler of [...handlers]) {
      await handler(message);
    }
  }

  subscribe(topic: string, handler: EventHandler): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.topics.get(topic);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.topics.delete(topic);
    };
  }
}

export function createMemoryEventBus(options?: { id?: string }): EventBus {
  const id = options?.id?.trim() || MEMORY_EVENT_BUS_ID;
  return new MemoryEventBus(id);
}

registerEventBus(createMemoryEventBus({ id: MEMORY_EVENT_BUS_ID }), {
  provenance: 'builtin',
  source: 'libs/core/event/memory-event-bus.ts',
});
