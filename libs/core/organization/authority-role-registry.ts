import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from '../secure-io.js';
import { baseAuthorityRoleOf, isBaseAuthorityRoleName } from '../foundation/base-authority-role.js';

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

// ---------------------------------------------------------------------------
// Org Role cards (concept model v2 D6): an Org Role carries no permissions of
// its own; its card (`knowledge/product/roles/<role>/role.json`) names the
// default Grant it maps to — registry entries only. `pnpm kyberion sync
// org-role-grants` projects the cards into role-authority-map.json.

/** The groups of role-authority-map.json, in file order (`<role_class>_roles`). */
export const ORG_ROLE_CLASSES = ['system', 'mission', 'context'] as const;
export type OrgRoleClass = (typeof ORG_ROLE_CLASSES)[number];

/** The default Grant of an Org Role: pointers into the role registry. */
export interface OrgRoleDefaultGrant {
  /** An Authority Role card, or null when the role has none. */
  authority_role: string | null;
  /** The base Authority Role short name (`worker` runs on `base_worker`). */
  base_role: string;
  execution_mode: string;
}

export interface OrgRoleCard {
  role: string;
  role_class: OrgRoleClass;
  default_grant: OrgRoleDefaultGrant;
}

/** One role-authority-map.json entry (the generated projection of a card). */
export interface RoleAuthorityMapEntry {
  role: string;
  authority_role?: string;
  persona: string;
  execution_mode: string;
}

export type RoleAuthorityMapGroups = Record<`${OrgRoleClass}_roles`, RoleAuthorityMapEntry[]>;

/** Base role values with no base Authority Role card (they never had a bundle). */
const BASE_ROLES_WITHOUT_CARD: ReadonlySet<string> = new Set(['mission_owner']);

const ORG_ROLE_CARD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/org-role-card.schema.json'
);
const orgRoleCardCatalogs = new Map<string, GovernedCatalog<OrgRoleCard>>();

function getOrgRoleCardCatalog(filePath: string): GovernedCatalog<OrgRoleCard> {
  const existing = orgRoleCardCatalogs.get(filePath);
  if (existing) return existing;
  const catalog = defineCatalog<OrgRoleCard>({
    id: 'org-role-card',
    path: filePath,
    schema: ORG_ROLE_CARD_SCHEMA_PATH,
  });
  orgRoleCardCatalogs.set(filePath, catalog);
  return catalog;
}

/**
 * Every Org Role card under `knowledge/product/roles/`, keyed by role id (the
 * directory name). A role directory without `role.json` has no card.
 */
export function loadOrgRoleCards(rootDir?: string): Record<string, OrgRoleCard> {
  const directory = knowledgePath(rootDir, 'product/roles');
  if (!safeExistsSync(directory)) return {};
  const cards: Record<string, OrgRoleCard> = {};
  for (const entry of safeReaddir(directory).sort()) {
    if (entry.startsWith('.') || !safeStat(path.join(directory, entry)).isDirectory()) continue;
    const filePath = assertSafeRepositoryPath(path.join(directory, entry, 'role.json'), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(filePath)) continue;
    const catalog = getOrgRoleCardCatalog(filePath);
    catalog.reset();
    const card = catalog.load();
    if (card.role !== entry) {
      throw new Error(`Org Role card ${entry}/role.json must match its directory (${card.role})`);
    }
    cards[entry] = card;
  }
  return cards;
}

/**
 * The reasons the cards do not point at registry entries: an `authority_role`
 * with no Authority Role card (or naming a base role, which is never a
 * principal's own role), or a `base_role` that is not a known base role.
 */
export function validateOrgRoleCards(
  cards: Readonly<Record<string, OrgRoleCard>>,
  authorityRoles: Readonly<Record<string, unknown>>
): string[] {
  const errors: string[] = [];
  for (const [role, card] of Object.entries(cards)) {
    const { authority_role: authorityRole, base_role: baseRole } = card.default_grant;
    if (authorityRole !== null) {
      if (isBaseAuthorityRoleName(authorityRole)) {
        errors.push(`${role}: authority_role '${authorityRole}' is a base role; use base_role`);
      } else if (!Object.hasOwn(authorityRoles, authorityRole)) {
        errors.push(
          `${role}: authority_role '${authorityRole}' has no card in knowledge/product/governance/authority-roles/`
        );
      }
    }
    const baseCard = baseAuthorityRoleOf(baseRole);
    if (baseCard) {
      if (!Object.hasOwn(authorityRoles, baseCard)) {
        errors.push(`${role}: base_role '${baseRole}' has no registry card ${baseCard}.json`);
      }
    } else if (!BASE_ROLES_WITHOUT_CARD.has(baseRole)) {
      errors.push(`${role}: base_role '${baseRole}' is not a known base role`);
    }
  }
  return errors;
}

/** The role-authority-map.json entry a card projects to. */
export function roleAuthorityMapEntryOf(card: OrgRoleCard): RoleAuthorityMapEntry {
  const grant = card.default_grant;
  return {
    role: card.role,
    ...(grant.authority_role ? { authority_role: grant.authority_role } : {}),
    persona: grant.base_role,
    execution_mode: grant.execution_mode,
  };
}

/**
 * The role-authority-map.json groups projected from the cards. Roles keep
 * their position in `existingOrder` (the current map's order per group) so a
 * regeneration only moves what changed; new roles follow, sorted.
 */
export function projectRoleAuthorityMap(
  cards: Readonly<Record<string, OrgRoleCard>>,
  existingOrder: Partial<Record<keyof RoleAuthorityMapGroups, readonly string[]>> = {}
): RoleAuthorityMapGroups {
  const groups = {} as RoleAuthorityMapGroups;
  for (const roleClass of ORG_ROLE_CLASSES) {
    const group = `${roleClass}_roles` as const;
    const members = Object.keys(cards).filter((role) => cards[role]!.role_class === roleClass);
    const order = existingOrder[group] ?? [];
    const ordered = [
      ...order.filter((role) => members.includes(role)),
      ...members.filter((role) => !order.includes(role)).sort(),
    ];
    groups[group] = ordered.map((role) => roleAuthorityMapEntryOf(cards[role]!));
  }
  return groups;
}
