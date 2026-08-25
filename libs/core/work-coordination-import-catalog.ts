import { pathResolver } from './path-resolver.js';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { safeExistsSync } from './secure-io.js';

export interface WorkCoordinationImportCatalogEntry {
  id: string;
  command: string;
  source: 'github' | 'jira';
  default_project_id?: string | null;
  summary?: string;
  notes?: string;
}

interface WorkCoordinationImportCatalog {
  version: string;
  imports: WorkCoordinationImportCatalogEntry[];
}

const PUBLIC_CATALOG_PATH = pathResolver.knowledge(
  'product/governance/work-coordination-import-catalog.json'
);
const PERSONAL_CATALOG_PATH = pathResolver.knowledge(
  'personal/governance/work-coordination-import-catalog.json'
);
const SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/work-coordination-import-catalog.schema.json'
);

const publicCatalog = defineCatalog<WorkCoordinationImportCatalog>({
  id: 'work-coordination-import-catalog.public',
  path: PUBLIC_CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: { version: '1.0.0', imports: [] },
});
const personalCatalog = defineCatalog<WorkCoordinationImportCatalog>({
  id: 'work-coordination-import-catalog.personal',
  path: PERSONAL_CATALOG_PATH,
  schema: SCHEMA_PATH,
  fallback: { version: '1.0.0', imports: [] },
});

function loadCatalogFile(
  catalogPath: string,
  catalog: GovernedCatalog<WorkCoordinationImportCatalog>
): WorkCoordinationImportCatalog | null {
  if (!safeExistsSync(catalogPath)) return null;
  return catalog.load();
}

function mergeCatalogs(
  base: WorkCoordinationImportCatalog,
  overlay: WorkCoordinationImportCatalog
): WorkCoordinationImportCatalog {
  const byId = new Map<string, WorkCoordinationImportCatalogEntry>();
  for (const entry of base.imports) byId.set(entry.id, entry);
  for (const entry of overlay.imports) byId.set(entry.id, entry);
  return {
    version: overlay.version || base.version || '1.0.0',
    imports: Array.from(byId.values()),
  };
}

export function loadWorkCoordinationImportCatalog(): WorkCoordinationImportCatalog {
  const base = loadCatalogFile(PUBLIC_CATALOG_PATH, publicCatalog) ?? {
    version: '1.0.0',
    imports: [],
  };
  const personal = loadCatalogFile(PERSONAL_CATALOG_PATH, personalCatalog) ?? {
    version: base.version,
    imports: [],
  };
  const merged = mergeCatalogs(base, personal);
  return merged;
}

export function listWorkCoordinationImportCatalogEntries(): WorkCoordinationImportCatalogEntry[] {
  return loadWorkCoordinationImportCatalog().imports;
}

export function getWorkCoordinationImportCatalogEntryByCommand(
  command: string
): WorkCoordinationImportCatalogEntry | null {
  const normalized = command.trim();
  if (!normalized) return null;
  return (
    listWorkCoordinationImportCatalogEntries().find((entry) => entry.command === normalized) || null
  );
}

export function resetWorkCoordinationImportCatalogCache(): void {
  publicCatalog.reset();
  personalCatalog.reset();
}
