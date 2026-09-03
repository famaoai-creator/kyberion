import { defineCatalog } from './foundation/governed-catalog.js';
import { knowledge } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface KnowledgeScopeCheckPolicy {
  version: string;
  description: string;
  max_direct_tenant_env_reads: number;
  legacy_quarantine_ttl_days: number;
  confidential_scope_allowlist: string[];
  scoped_runtime_writer_files: string[];
}

const POLICY_SCHEMA_PATH = knowledge('product/schemas/knowledge-scope-check.schema.json');

function policyCatalog(filePath: string) {
  return defineCatalog<KnowledgeScopeCheckPolicy>({
    id: 'knowledge-scope-check-policy',
    path: filePath,
    schema: POLICY_SCHEMA_PATH,
  });
}

export function loadKnowledgeScopeCheckPolicy(
  filePath = knowledge('product/governance/knowledge-scope-check.json')
): KnowledgeScopeCheckPolicy | null {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return null;
  try {
    if (!safeLstat(safeFilePath).isFile()) return null;
    return policyCatalog(safeFilePath).load();
  } catch {
    return null;
  }
}
