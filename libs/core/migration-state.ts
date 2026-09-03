import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { knowledge } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export interface MigrationState {
  applied: string[];
}

const MIGRATION_STATE_SCHEMA_PATH = knowledge('product/schemas/migration-state.schema.json');

function migrationStateCatalog(filePath: string) {
  return defineCatalog<MigrationState>({
    id: 'migration-state',
    path: filePath,
    schema: MIGRATION_STATE_SCHEMA_PATH,
  });
}

export function readMigrationState(statePath: string): MigrationState {
  const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeStatePath)) return { applied: [] };
  if (!safeLstat(safeStatePath).isFile()) {
    throw new Error(`Migration state must be a regular file: ${safeStatePath}`);
  }

  try {
    try {
      return migrationStateCatalog(safeStatePath).load();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith('Invalid catalog migration-state')
      ) {
        throw error;
      }
      // Preserve the runner's fail-safe behavior for a syntactically valid but
      // unusable state: rerunning migrations is safer than trusting it.
      return { applied: [] };
    }
  } catch (error) {
    throw new Error(
      `Failed to read migration state at ${safeStatePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function writeMigrationState(statePath: string, state: MigrationState): void {
  const safeStatePath = assertSafeRepositoryPath(statePath, { allowMissingLeaf: true });
  if (safeExistsSync(safeStatePath) && !safeLstat(safeStatePath).isFile()) {
    throw new Error(`Migration state must be a regular file: ${safeStatePath}`);
  }
  const validated = migrationStateCatalog(safeStatePath).validate(state, safeStatePath);
  safeMkdir(path.dirname(safeStatePath), { recursive: true });
  safeWriteFile(safeStatePath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
  });
}
