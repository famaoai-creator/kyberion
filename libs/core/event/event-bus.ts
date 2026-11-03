/**
 * event-bus seam — the pluggable in-process / distributed notification
 * extension point (AGY refinement leftover: event-driven mission coordination
 * without shipping Redis PubSub).
 *
 * Callers publish topic messages and subscribe handlers; selection order is
 * governed data (`seam-provider-selection/event-bus.json` `default_chains`),
 * never a hard-coded preference list. `local-process` is the governed default
 * (same implementation as `memory`, distinct id for selection-policy clarity);
 * `memory` is registered for hermetic tests but never auto-selected.
 *
 * Distributed providers (Redis PubSub / NATS / …) can register later without
 * touching call sites that already resolve through this seam.
 */

import { createProviderRegistry } from '../provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import { getSeamSelectionPolicy } from '../seam-provider-selection.js';

export const EVENT_BUS_SEAM = 'event-bus';
/** Builtin default provider id; also the governed `default_provider`. */
export const LOCAL_EVENT_BUS_ID = 'local-process';

export interface EventBusMessage {
  topic: string;
  payload: unknown;
  published_at_ms: number;
}

export interface EventBus {
  readonly id: string;
  publish(topic: string, payload: unknown): Promise<void> | void;
  subscribe(topic: string, handler: (msg: EventBusMessage) => void | Promise<void>): () => void;
}

const eventBusRegistry = createProviderRegistry<EventBus>({
  seam: EVENT_BUS_SEAM,
  owner: 'libs/core/event/event-bus.ts',
  source: 'event-bus-extension',
  missingIdError: 'EventBus must have a non-empty id',
});

export function registerEventBus(bus: EventBus, metadata?: SeamProviderMetadata): () => void {
  return eventBusRegistry.register(bus, metadata);
}

export function listEventBuses(): EventBus[] {
  return eventBusRegistry.list();
}

export function getEventBus(id: string): EventBus | undefined {
  return eventBusRegistry.get(id);
}

export function resetEventBuses(): void {
  eventBusRegistry.reset();
}

/**
 * Resolve the bus for a caller. An explicit selector always wins; without one
 * the governed `default_chains.default` ordering picks the first registered
 * provider, falling back to `local-process` then to whatever is registered.
 * Throws when nothing is registered — local-process is installed by importing
 * `local-event-bus.ts`.
 */
export function resolveEventBus(selector?: string): EventBus {
  const explicit = selector?.trim();
  if (explicit) {
    const bus = eventBusRegistry.get(explicit);
    if (!bus) {
      throw new Error(
        `[EVENT_BUS] unknown bus '${explicit}' — registered: ${
          eventBusRegistry
            .list()
            .map((b) => b.id)
            .join(', ') || '(none)'
        }`
      );
    }
    return bus;
  }
  const chain = getSeamSelectionPolicy(EVENT_BUS_SEAM)?.default_chains?.default ?? [
    LOCAL_EVENT_BUS_ID,
  ];
  for (const id of chain) {
    const bus = eventBusRegistry.get(id);
    if (bus) return bus;
  }
  const first = eventBusRegistry.list()[0];
  if (first) return first;
  throw new Error(
    '[EVENT_BUS] no bus registered — import @agent/core/event/local-event-bus (or register one)'
  );
}
