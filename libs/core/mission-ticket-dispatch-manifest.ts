import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type { MissionTicketDispatchManifest } from './mission-ticket-dispatch.js';

const TICKET_DISPATCH_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-ticket-dispatch-manifest.schema.json'
);

/** Load a ticket dispatch manifest through one schema and file boundary. */
export function loadMissionTicketDispatchManifestAtPath(
  filePath: string
): MissionTicketDispatchManifest {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) {
    throw new Error(`[MISSION_TICKET_DISPATCH_MANIFEST] manifest is missing: ${filePath}`);
  }
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(
      `[MISSION_TICKET_DISPATCH_MANIFEST] manifest must be a regular file: ${filePath}`
    );
  }
  return defineCatalog<MissionTicketDispatchManifest>({
    id: 'mission-ticket-dispatch-manifest',
    path: safeFilePath,
    schema: TICKET_DISPATCH_MANIFEST_SCHEMA_PATH,
  }).load();
}
