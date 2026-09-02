import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { A2AMessage } from './a2a-bridge.js';

const A2A_ENVELOPE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/a2a-envelope.schema.json');

const a2aEnvelopeCatalog = defineCatalog<A2AMessage>({
  id: 'a2a-envelope',
  path: A2A_ENVELOPE_SCHEMA_PATH,
  schema: A2A_ENVELOPE_SCHEMA_PATH,
});

/** Validate an A2A envelope before it reaches a dispatcher or actuator. */
export function validateA2AEnvelope(value: unknown, sourcePath = 'A2A envelope'): A2AMessage {
  return a2aEnvelopeCatalog.validate(value, sourcePath);
}
