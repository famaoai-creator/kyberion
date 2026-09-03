import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

export interface SoakRestartState {
  healthy: boolean;
  resumed: boolean;
  phase: 'bootstrap' | 'resume';
  restored_from?: string | null;
}

const SOAK_RESTART_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/soak-restart-state.schema.json'
);

function soakRestartStateCatalogAtPath(filePath: string) {
  return defineCatalog<SoakRestartState>({
    id: 'soak-restart-state',
    path: filePath,
    schema: SOAK_RESTART_STATE_SCHEMA_PATH,
  });
}

/** Load a restart smoke state through the shared schema and path boundary. */
export function loadSoakRestartStateAtPath(filePath: string): SoakRestartState {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[SOAK_RESTART_STATE] state must be a regular file: ${filePath}`);
  }
  return soakRestartStateCatalogAtPath(safePath).load();
}

/** Validate and persist a restart smoke state using the same contract as the reader. */
export function writeSoakRestartStateAtPath(
  filePath: string,
  state: SoakRestartState
): SoakRestartState {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = soakRestartStateCatalogAtPath(safePath).validate(state, safePath);
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
  return validated;
}
