import { defineCatalog } from './foundation/governed-catalog.js';
import type { MissionState } from './mission-types.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeWriteFile } from './secure-io.js';

function missionStateCatalog(filePath: string) {
  return defineCatalog<MissionState>({
    id: 'mission-state',
    path: filePath,
    schema: pathResolver.rootResolve('knowledge/product/schemas/mission-state.schema.json'),
  });
}

/** Load mission state from an already resolved repository path. */
export function loadMissionStateAtPath(statePath: string): MissionState | null {
  try {
    return missionStateCatalog(statePath).load();
  } catch (_) {
    return null;
  }
}

export function writeMissionStateAtPath(statePath: string, state: MissionState): string {
  const safePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
  const validated = missionStateCatalog(safePath).validate(state, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2), {
    encoding: 'utf8',
    mkdir: true,
  });
  return safePath;
}
