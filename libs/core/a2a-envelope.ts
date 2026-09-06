import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type { A2AMessage } from './a2a-bridge.js';

const A2A_ENVELOPE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/a2a-envelope.schema.json');

function a2aEnvelopeCatalogAtPath(filePath: string) {
  return defineCatalog<A2AMessage>({
    id: 'a2a-envelope',
    path: filePath,
    schema: A2A_ENVELOPE_SCHEMA_PATH,
  });
}

/** Validate an A2A envelope before it reaches a dispatcher or actuator. */
export function validateA2AEnvelope(value: unknown, sourcePath = 'A2A envelope'): A2AMessage {
  return a2aEnvelopeCatalogAtPath(sourcePath).validate(value, sourcePath);
}

/** Load an A2A envelope through the repository and regular-file boundary. */
export function loadA2AEnvelopeAtPath(filePath: string): A2AMessage {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[A2A_ENVELOPE_FILE] input must be a regular file: ${filePath}`);
  }
  return a2aEnvelopeCatalogAtPath(safePath).load();
}
