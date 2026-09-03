import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';
import type { MissionWorkItemDispatchManifest } from './mission-workitem-dispatch-review.js';

const DISPATCH_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-workitem-dispatch-manifest.schema.json'
);

/** Load a work-item dispatch manifest through one schema and file boundary. */
export function loadMissionWorkItemDispatchManifestAtPath(
  filePath: string
): MissionWorkItemDispatchManifest {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) {
    throw new Error(`[MISSION_DISPATCH_MANIFEST] manifest is missing: ${filePath}`);
  }
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_DISPATCH_MANIFEST] manifest must be a regular file: ${filePath}`);
  }
  return defineCatalog<MissionWorkItemDispatchManifest>({
    id: 'mission-workitem-dispatch-manifest',
    path: safeFilePath,
    schema: DISPATCH_MANIFEST_SCHEMA_PATH,
  }).load();
}
