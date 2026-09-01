import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from './secure-io.js';

/** The governed authority role shape shared by runtime consumers. */
export interface AuthorityRoleRecord {
  role?: string;
  description: string;
  default_persona?: string;
  write_scopes: string[];
  scope_classes: string[];
  allowed_actuators: string[];
  tier_access: string[];
}

interface AuthorityRoleIndex {
  version: string;
  authority_roles: Record<string, AuthorityRoleRecord>;
}

const AUTHORITY_ROLE_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/authority-role-index.schema.json'
);
const AUTHORITY_ROLE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/authority-role.schema.json'
);

const authorityRoleCatalogs = new Map<string, GovernedCatalog<AuthorityRoleRecord>>();
const authorityRoleIndexCatalogs = new Map<string, GovernedCatalog<AuthorityRoleIndex>>();

function getAuthorityRoleCatalog(filePath: string): GovernedCatalog<AuthorityRoleRecord> {
  const existing = authorityRoleCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<AuthorityRoleRecord>({
    id: 'authority-role',
    path: filePath,
    schema: AUTHORITY_ROLE_SCHEMA_PATH,
  });
  authorityRoleCatalogs.set(filePath, catalog);
  return catalog;
}

function getAuthorityRoleIndexCatalog(filePath: string): GovernedCatalog<AuthorityRoleIndex> {
  const existing = authorityRoleIndexCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<AuthorityRoleIndex>({
    id: 'authority-role-index',
    path: filePath,
    schema: AUTHORITY_ROLE_INDEX_SCHEMA_PATH,
  });
  authorityRoleIndexCatalogs.set(filePath, catalog);
  return catalog;
}

function knowledgePath(rootDir: string | undefined, relativePath: string): string {
  const candidate = rootDir
    ? path.join(rootDir, 'knowledge', ...relativePath.split('/'))
    : pathResolver.knowledge(relativePath);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function loadAuthorityRoleDirectory(
  directoryPath: string
): Record<string, AuthorityRoleRecord> | null {
  const safeDirectoryPath = assertSafeRepositoryPath(directoryPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDirectoryPath)) return null;

  const files = safeReaddir(safeDirectoryPath)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;

  const roles: Record<string, AuthorityRoleRecord> = {};
  for (const file of files) {
    const filePath = assertSafeRepositoryPath(path.join(safeDirectoryPath, file));
    const payload = getAuthorityRoleCatalog(filePath).load();
    const role = String(payload.role || '').trim();
    if (!role) {
      throw new Error(`Authority role file ${file} must declare a role id`);
    }
    if (role !== file.replace(/\.json$/i, '')) {
      throw new Error(`Authority role file ${file} must match its role id (${role})`);
    }
    roles[role] = payload;
  }

  return roles;
}

/**
 * Load the canonical authority role directory, falling back to its generated
 * snapshot only when the directory is absent or empty.
 */
export function loadAuthorityRoleIndex(rootDir?: string): Record<string, AuthorityRoleRecord> {
  const directory = knowledgePath(rootDir, 'product/governance/authority-roles');
  const directoryRoles = loadAuthorityRoleDirectory(directory);
  if (directoryRoles) return directoryRoles;

  const indexPath = knowledgePath(rootDir, 'product/governance/authority-role-index.json');
  const index = getAuthorityRoleIndexCatalog(indexPath).load();
  return index.authority_roles;
}
