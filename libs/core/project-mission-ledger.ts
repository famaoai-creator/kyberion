import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

const PROJECT_MISSION_LEDGER_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/project-mission-ledger.schema.json'
);

export interface ProjectMissionLedgerEntry {
  mission_id: string;
  relationship_type: 'belongs_to' | 'supports' | 'governs' | 'independent';
  status: string;
  summary: string;
  [key: string]: unknown;
}

export interface ProjectMissionLedger {
  project_id: string;
  project_name?: string;
  entries: ProjectMissionLedgerEntry[];
  [key: string]: unknown;
}

function projectMissionLedgerCatalogAtPath(filePath: string) {
  return defineCatalog<ProjectMissionLedger>({
    id: 'project-mission-ledger',
    path: filePath,
    schema: PROJECT_MISSION_LEDGER_SCHEMA_PATH,
  });
}

/** Load a project mission ledger through its shared schema and file boundary. */
export function loadProjectMissionLedgerAtPath(filePath: string): ProjectMissionLedger | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[PROJECT_MISSION_LEDGER] ledger must be a regular file: ${filePath}`);
  }
  return projectMissionLedgerCatalogAtPath(safeFilePath).load();
}

/** Validate and persist a project mission ledger using the same contract. */
export function writeProjectMissionLedgerAtPath(
  filePath: string,
  ledger: ProjectMissionLedger
): ProjectMissionLedger {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const catalog = projectMissionLedgerCatalogAtPath(safeFilePath);
  const validated = catalog.validate(ledger, safeFilePath);
  safeWriteFile(safeFilePath, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}
