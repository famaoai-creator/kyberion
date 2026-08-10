/**
 * EV-09: carry the trigger delivery id through everything one firing causes.
 *
 * A cron firing produced a delivery receipt, a pipeline trace, worker events,
 * mission events and possibly an operator notification — each with its own id,
 * and nothing linking them. Answering "what did last night's 03:00 job do, and
 * why did that notification arrive?" meant correlating timestamps by hand
 * across five files.
 *
 * The id lives in AsyncLocalStorage rather than an environment variable or a
 * threaded parameter: a trigger delivery is an async scope, concurrent
 * deliveries must not see each other's id, and every emitter in the causal tree
 * would otherwise need a new parameter.
 *
 * This module deliberately holds nothing but the storage, so both the trigger
 * runner (which sets it) and the event/notification writers (which read it) can
 * import it without an import cycle.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TriggerCorrelationScope {
  deliveryId: string;
  source: 'cron' | 'watch' | 'wake';
  idempotencyKey: string;
}

const triggerCorrelationStorage = new AsyncLocalStorage<TriggerCorrelationScope>();

/** Run `fn` with the given trigger delivery as the ambient correlation scope. */
export function withTriggerCorrelation<T>(scope: TriggerCorrelationScope, fn: () => T): T {
  return triggerCorrelationStorage.run(scope, fn);
}

/** The delivery id of the trigger currently being delivered, if any. */
export function currentTriggerDeliveryId(): string | undefined {
  return triggerCorrelationStorage.getStore()?.deliveryId;
}

/** The full correlation scope, for writers that also record source/key. */
export function currentTriggerCorrelation(): TriggerCorrelationScope | undefined {
  return triggerCorrelationStorage.getStore();
}
