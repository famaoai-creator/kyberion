/**
 * local-process event bus — the governed default.
 *
 * Same in-process implementation as `memory`, registered under a distinct id
 * so selection policy can name the default without auto-selecting the hermetic
 * test provider. Importing this module installs `local-process` on the
 * event-bus seam.
 */

import { LOCAL_EVENT_BUS_ID, registerEventBus } from './event-bus.js';
import { createMemoryEventBus } from './memory-event-bus.js';

export const localProcessEventBus = createMemoryEventBus({ id: LOCAL_EVENT_BUS_ID });

registerEventBus(localProcessEventBus, {
  provenance: 'builtin',
  source: 'libs/core/event/local-event-bus.ts',
});
