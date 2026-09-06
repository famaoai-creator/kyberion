import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface MissionWorkItemDispatchResponseArtifact {
  path: string;
  kind: string;
}

export interface MissionWorkItemDispatchResponseSeed {
  summary?: string;
  artifacts?: MissionWorkItemDispatchResponseArtifact[];
}

interface MissionWorkItemDispatchResponseEnvelope {
  task_result?: MissionWorkItemDispatchResponseSeed;
}

const DISPATCH_RESPONSE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-workitem-dispatch-response.schema.json'
);

/**
 * Load the small, legacy-compatible projection used by context-pack seeding.
 * The persisted dispatch response has a broad envelope, so the nested
 * projection is validated without requiring fields introduced after older
 * response artifacts were written.
 */
export function loadMissionWorkItemDispatchResponseSeedAtPath(
  filePath: string
): MissionWorkItemDispatchResponseSeed | undefined {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath) || !safeLstat(safeFilePath).isFile()) return undefined;

  try {
    return (
      defineCatalog<MissionWorkItemDispatchResponseEnvelope>({
        id: 'mission-workitem-dispatch-response',
        path: safeFilePath,
        schema: DISPATCH_RESPONSE_SCHEMA_PATH,
      }).load().task_result || undefined
    );
  } catch {
    return undefined;
  }
}
