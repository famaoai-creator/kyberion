import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

export interface TenantRegistryException {
  slug: string;
  reason: string;
}

export interface TenantRegistryExceptionsFile {
  _meta: string;
  exceptions: TenantRegistryException[];
}

const EXCEPTIONS_RELATIVE_PATH = 'knowledge/product/governance/tenant-registry-exceptions.json';
const EXCEPTIONS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/tenant-registry-exceptions.schema.json'
);

function exceptionsPath(rootDir: string): string {
  return assertSafeRepositoryPath(path.join(rootDir, EXCEPTIONS_RELATIVE_PATH), {
    allowMissingLeaf: true,
    rootDir,
  });
}

/** Load the tenant exception allowlist through the shared schema boundary. */
export function loadTenantRegistryExceptionsFile(
  rootDir = pathResolver.rootDir()
): TenantRegistryExceptionsFile | null {
  const filePath = exceptionsPath(rootDir);
  if (!safeExistsSync(filePath)) return null;
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`Tenant registry exceptions must be a regular file: ${filePath}`);
  }
  return defineCatalog<TenantRegistryExceptionsFile>({
    id: 'tenant-registry-exceptions',
    path: filePath,
    schema: EXCEPTIONS_SCHEMA_PATH,
  }).load();
}
