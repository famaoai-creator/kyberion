import { defineCatalog } from '../foundation/governed-catalog.js';
import { loadJsonIfPresent } from '../foundation/json.js';
import type { MissionState } from './mission-types.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeWriteFile } from '../secure-io.js';

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

/**
 * Load mission state from an already resolved path WITHOUT swallowing errors:
 * a read denial or a schema-invalid state throws, so a caller can tell
 * "denied" from "absent". The caller checks the file exists first.
 */
export function readMissionStateAtPath(statePath: string): MissionState {
  return missionStateCatalog(statePath).load();
}

/**
 * Reads mission state as an inference hint rather than as an authority.
 *
 * The governed catalog above enforces the full mission-state contract — nine
 * required fields. Scope inference must not: a legacy or half-written
 * `mission-state.json` fails that contract, and treating the failure as "no
 * state" silently drops the mission's `tier` and `tenant_slug`, resolving a
 * confidential mission as `public`. Reads still go through the governed
 * secure-io bridge, and callers are expected to have asserted the path first.
 */
export function loadMissionStateForInference(statePath: string): Partial<MissionState> | null {
  try {
    const parsed = loadJsonIfPresent<unknown>(statePath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Partial<MissionState>;
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
