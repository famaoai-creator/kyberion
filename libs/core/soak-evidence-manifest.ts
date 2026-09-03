import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

export interface SoakEvidenceManifest {
  version: '1.0';
  started_at: string;
  last_run_at: string;
  run_count: number;
  total_cycles: number;
  window_days_equivalent: number;
  last_validation: {
    ok: boolean;
    regression_count: number;
    issues: string[];
  };
}

const SOAK_EVIDENCE_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/soak-evidence-manifest.schema.json'
);

function soakEvidenceManifestCatalogAtPath(filePath: string) {
  return defineCatalog<SoakEvidenceManifest>({
    id: 'soak-evidence-manifest',
    path: filePath,
    schema: SOAK_EVIDENCE_MANIFEST_SCHEMA_PATH,
  });
}

/** Load one live soak manifest through the shared schema and path boundary. */
export function loadSoakEvidenceManifestAtPath(filePath: string): SoakEvidenceManifest {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[SOAK_EVIDENCE_MANIFEST] manifest must be a regular file: ${filePath}`);
  }
  return soakEvidenceManifestCatalogAtPath(safePath).load();
}

/** Validate and persist a live soak manifest using the same contract as the reader. */
export function writeSoakEvidenceManifestAtPath(
  filePath: string,
  manifest: SoakEvidenceManifest
): SoakEvidenceManifest {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = soakEvidenceManifestCatalogAtPath(safePath).validate(manifest, safePath);
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
  return validated;
}
