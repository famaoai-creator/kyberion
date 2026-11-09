import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '../secure-io.js';

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

/**
 * One card of the Authority Role registry (concept model v2 D6): the role's
 * catalog profile (assignable roles only) and its path permissions, which
 * `sync_authority_roles` projects verbatim into security-policy.json
 * `authority_role_permissions`. A process role (`assignable: false`) is
 * assumed by a script or service only; it carries no catalog profile and is
 * not offered to teams, organizations or dots.
 */
export interface AuthorityRoleCard extends Partial<Omit<AuthorityRoleRecord, 'role'>> {
  role: string;
  assignable?: boolean;
  permissions?: Record<string, unknown>;
}

/** Card fields that never reach the assignable role catalog. */
const REGISTRY_ONLY_FIELDS = ['assignable', 'permissions'] as const;

function readAuthorityRoleCards(directoryPath: string): Record<string, AuthorityRoleCard> | null {
  const safeDirectoryPath = assertSafeRepositoryPath(directoryPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDirectoryPath)) return null;

  const files = safeReaddir(safeDirectoryPath)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;

  const cards: Record<string, AuthorityRoleCard> = {};
  for (const file of files) {
    const filePath = assertSafeRepositoryPath(path.join(safeDirectoryPath, file));
    const payload = getAuthorityRoleCatalog(filePath).load() as unknown as AuthorityRoleCard;
    const role = String(payload.role || '').trim();
    if (!role) {
      throw new Error(`Authority role file ${file} must declare a role id`);
    }
    if (role !== file.replace(/\.json$/i, '')) {
      throw new Error(`Authority role file ${file} must match its role id (${role})`);
    }
    cards[role] = payload;
  }

  return cards;
}

/** Is the card offered in the assignable role catalog (index, teams, dots)? */
export function isAssignableAuthorityRoleCard(card: AuthorityRoleCard): boolean {
  return card.assignable !== false;
}

/** The catalog profile of an assignable card, without the registry-only fields. */
export function authorityRoleCardProfile(card: AuthorityRoleCard): AuthorityRoleRecord {
  const profile: Record<string, unknown> = { ...card };
  for (const field of REGISTRY_ONLY_FIELDS) delete profile[field];
  return profile as unknown as AuthorityRoleRecord;
}

function loadAuthorityRoleDirectory(
  directoryPath: string
): Record<string, AuthorityRoleRecord> | null {
  const cards = readAuthorityRoleCards(directoryPath);
  if (!cards) return null;
  const roles: Record<string, AuthorityRoleRecord> = {};
  for (const [role, card] of Object.entries(cards)) {
    if (isAssignableAuthorityRoleCard(card)) roles[role] = authorityRoleCardProfile(card);
  }
  return roles;
}

/**
 * Every card of the Authority Role registry, assignable and process roles
 * alike, or null when the canonical directory is absent or empty.
 */
export function loadAuthorityRoleCards(rootDir?: string): Record<string, AuthorityRoleCard> | null {
  return readAuthorityRoleCards(knowledgePath(rootDir, 'product/governance/authority-roles'));
}

/**
 * The security-policy.json `authority_role_permissions` projection of the
 * registry: one entry per card that declares `permissions`, copied verbatim.
 * Roles keep their position in `existingOrder` (the current policy's key
 * order) so a regeneration only moves what changed; new roles follow, sorted.
 */
export function projectAuthorityRolePermissions(
  cards: Record<string, AuthorityRoleCard>,
  existingOrder: readonly string[] = []
): Record<string, Record<string, unknown>> {
  const withPermissions = Object.keys(cards).filter((role) => cards[role]?.permissions);
  const known = new Set(withPermissions);
  const ordered = [
    ...existingOrder.filter((role) => known.has(role)),
    ...withPermissions.filter((role) => !existingOrder.includes(role)).sort(),
  ];
  const projection: Record<string, Record<string, unknown>> = {};
  for (const role of ordered) projection[role] = cards[role]!.permissions!;
  return projection;
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
