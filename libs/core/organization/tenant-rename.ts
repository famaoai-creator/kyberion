import * as path from 'node:path';
import { readConfiguredActorIdentity } from '../identity-context-bridge.js';
import { auditChain, withAuditChainLock } from '../governance/audit-chain.js';
import { readJson, writeJson } from '../foundation/json.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import {
  defaultTenantKnowledgeRoot,
  readTenantProfile,
  tenantProfilePath,
  writeTenantProfile,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeStat,
} from '../secure-io.js';
import { isValidTenantSlug } from '../entity-scope.js';

export type TenantLifecycleVerb = 'create' | 'update' | 'suspend' | 'resume' | 'archive';

/* ---------------------------------------------------------------------------
 * Tenant slug rename
 *
 * A slug is not a label: it is the path segment of `knowledge/confidential/
 * {slug}/`, the directory name under `active/organizations/{tier}/`, and the
 * value that project records and mission state carry to prove containment.
 * Renaming a company therefore means moving storage and rewriting every
 * structural reference — not editing a display string.
 *
 * `tenant_id` is deliberately preserved. The slug is where the data lives; the
 * id is who the tenant is. Keeping the id stable means audit records written
 * before the rename still join to the tenant after it.
 * ------------------------------------------------------------------------- */

/** One directory or file relocation the rename performs. */
export interface TenantRenameMove {
  kind: 'profile' | 'knowledge_root' | 'organization_state' | 'customer_overlay';
  from: string;
  to: string;
}

/** One structural field rewritten inside a JSON record. */
export interface TenantRenameRewrite {
  file: string;
  field: string;
  from: string;
  to: string;
}

export interface TenantRenameInput extends TenantRegistryPathOptions {
  fromSlug: string;
  toSlug: string;
  /** Defaults to the existing display name; pass the new trade name here. */
  displayName?: string;
  /**
   * Rename the organization whose id equals the old slug. Organization ids are
   * slug-shaped by convention, so this defaults to true; pass false when the
   * organization keeps its identity across the company's rename.
   */
  renameOrganization?: boolean;
  /**
   * Walk the repo afterwards for surviving mentions of the old slug. Defaults
   * to true — the report is the point of the command. Tests turn it off to
   * avoid paying for a full-tree read they do not assert on.
   */
  scanResidual?: boolean;
  apply?: boolean;
  actor?: string;
}

export interface TenantRenameResult {
  status: 'dry-run' | 'applied';
  from_slug: string;
  to_slug: string;
  profile: TenantProfile;
  moves: TenantRenameMove[];
  rewrites: TenantRenameRewrite[];
  /**
   * Files that still mention the old slug in free text after the structural
   * rewrites. These are NOT edited automatically — prose, file names, and
   * design assets need a human decision, and silently rewriting them would
   * corrupt narrative documents.
   */
  residual_references: string[];
  organization_renamed?: string;
}

const RENAME_SCAN_ROOTS = [
  'knowledge/confidential',
  'knowledge/product',
  'knowledge/personal/tenants',
  'active/organizations',
  runtimeStatePath('organization.projectsRoot').physicalPath,
  'active/missions',
  'customer',
] as const;

const RENAME_SCAN_EXTENSIONS = ['.json', '.md', '.css', '.ts', '.html'];

/** Repo-relative path, POSIX-separated, for a stable report across platforms. */
function relative(rootDir: string, absolute: string): string {
  return path.relative(rootDir, absolute).split(path.sep).join('/');
}

/** Every file under `dir`, depth-first, skipping `.git` and dot directories. */
function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || !safeExistsSync(dir)) return out;
  for (const entry of safeReaddir(dir)) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    let isDir = false;
    try {
      isDir = safeStat(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkFiles(full, out, depth + 1);
    else out.push(full);
  }
  return out;
}

/** Directory holding one tenant's organizations, per tier. */
function organizationTenantDir(rootDir: string, tier: string, slug: string): string {
  return path.join(rootDir, 'active', 'organizations', tier, slug);
}

/**
 * Rewrites slug-valued fields in one JSON file. Only the named fields are
 * touched: a blind string replace would also hit prose inside `summary` and
 * `purpose`, where the old trade name is often a deliberate historical record.
 */
function rewriteJsonFields(
  file: string,
  fields: readonly string[],
  fromValue: string,
  toValue: string,
  rootDir: string,
  apply: boolean
): TenantRenameRewrite[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = readJson<Record<string, unknown>>(file);
  } catch {
    return [];
  }
  const changes: TenantRenameRewrite[] = [];
  for (const field of fields) {
    if (parsed[field] === fromValue) {
      changes.push({ file: relative(rootDir, file), field, from: fromValue, to: toValue });
      parsed[field] = toValue;
    }
  }
  if (changes.length && apply) {
    writeJson(file, parsed);
  }
  return changes;
}

function assertRenamePreconditions(input: TenantRenameInput, rootDir: string): TenantProfile {
  const { fromSlug, toSlug } = input;
  if (fromSlug === toSlug) throw new Error(`[tenant-rename] source and target slug are identical.`);
  if (!isValidTenantSlug(toSlug)) {
    throw new Error(
      `[tenant-rename] invalid target slug '${toSlug}'. Tier and partition names are reserved.`
    );
  }
  const options: TenantRegistryPathOptions = { rootDir: input.rootDir, env: input.env };
  const current = readTenantProfile(fromSlug, options);
  if (!current) throw new Error(`[tenant-rename] tenant '${fromSlug}' does not exist.`);
  if (current.status === 'archived') {
    throw new Error(`[tenant-rename] tenant '${fromSlug}' is archived and cannot be renamed.`);
  }
  if (readTenantProfile(toSlug, options)) {
    throw new Error(`[tenant-rename] tenant '${toSlug}' already exists.`);
  }
  const targetRoot = path.resolve(rootDir, defaultTenantKnowledgeRoot(toSlug));
  if (safeExistsSync(targetRoot)) {
    throw new Error(`[tenant-rename] target knowledge root already exists: ${targetRoot}`);
  }
  return current;
}

/**
 * Moves a tenant to a new slug and rewrites the structural references that
 * point at the old one. Dry-run by default: the returned plan lists every move
 * and rewrite so it can be reviewed before anything is touched.
 */
/** Audit action marking where a renamed tenant's audit mirror moved. */
export const TENANT_AUDIT_MIRROR_MOVED_ACTION = 'tenant.audit_mirror_moved';

/** Profile metadata key listing the audit ids of the tenant's move markers. */
export const AUDIT_MIRROR_MOVE_IDS_KEY = 'audit_mirror_move_ids';

/** The audit ids of the move markers this tenant's renames recorded. */
export function auditMirrorMoveIds(profile: Pick<TenantProfile, 'metadata'>): string[] {
  const ids = profile.metadata?.[AUDIT_MIRROR_MOVE_IDS_KEY];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Every slug the tenant was known by before, oldest first, repeats kept (a
 * rename back to a former slug is a step of its own). A profile renamed before
 * `previous_slugs` existed has its last previous slug, preceded by its
 * identity slug when that differs (the slug it was created under).
 */
export function previousSlugs(
  profile: Pick<TenantProfile, 'metadata' | 'tenant_id' | 'tenant_slug'>
): string[] {
  const metadata = profile.metadata || {};
  if (Array.isArray(metadata.previous_slugs)) {
    return metadata.previous_slugs.filter((slug): slug is string => typeof slug === 'string');
  }
  const last = typeof metadata.previous_slug === 'string' ? metadata.previous_slug : undefined;
  if (!last) return [];
  const first = profile.tenant_id;
  return first && first !== last && first !== profile.tenant_slug ? [first, last] : [last];
}

export function renameTenantWithPlan(input: TenantRenameInput): TenantRenameResult {
  const rootDir = input.rootDir ?? pathResolver.rootDir();
  const options: TenantRegistryPathOptions = { rootDir: input.rootDir, env: input.env };
  const { fromSlug, toSlug } = input;
  const current = assertRenamePreconditions(input, rootDir);
  const apply = Boolean(input.apply);
  const actorId = input.actor || readConfiguredActorIdentity().persona || 'operator';
  const renameOrg = input.renameOrganization !== false;

  // Both audit entries this rename writes are checked before anything moves:
  // one refused after the moves (an active tenant scope that conflicts with
  // the new slug, a missing chain key) would leave the tenant half renamed.
  const mirrorMovedEntry = {
    agentId: actorId,
    action: TENANT_AUDIT_MIRROR_MOVED_ACTION,
    operation: `tenant:${fromSlug}->${toSlug}`,
    result: 'completed',
    tenantSlug: toSlug,
    metadata: { previous_slug: fromSlug },
  } as const;
  if (apply) {
    auditChain.assertRecordable(mirrorMovedEntry);
  }

  let mirrorMovedId: string | undefined;
  const moves: TenantRenameMove[] = [];
  const rewrites: TenantRenameRewrite[] = [];
  let organizationRenamed: string | undefined;

  // 1. Knowledge root. Moved before the profile so a failure leaves the
  //    profile pointing at storage that still exists.
  const fromRoot = path.resolve(
    rootDir,
    current.knowledge_root || defaultTenantKnowledgeRoot(fromSlug)
  );
  const toRoot = path.resolve(rootDir, defaultTenantKnowledgeRoot(toSlug));
  if (safeExistsSync(fromRoot)) {
    moves.push({
      kind: 'knowledge_root',
      from: relative(rootDir, fromRoot),
      to: relative(rootDir, toRoot),
    });
    if (apply) {
      safeMkdir(path.dirname(toRoot), { recursive: true });
      safeMoveSync(fromRoot, toRoot);
    }
  }

  // 2. Organization state. The tenant directory always moves; the organization
  //    id only changes when it was named after the slug.
  for (const tier of ['confidential', 'personal', 'public']) {
    const fromOrgDir = organizationTenantDir(rootDir, tier, fromSlug);
    if (!safeExistsSync(fromOrgDir)) continue;
    const toOrgDir = organizationTenantDir(rootDir, tier, toSlug);
    if (safeExistsSync(toOrgDir)) {
      throw new Error(`[tenant-rename] target organization directory already exists: ${toOrgDir}`);
    }
    moves.push({
      kind: 'organization_state',
      from: relative(rootDir, fromOrgDir),
      to: relative(rootDir, toOrgDir),
    });
    if (apply) safeMoveSync(fromOrgDir, toOrgDir);
    // After the tenant directory moves, work from its new location. The plan
    // reports both legs against the post-move parent so the two moves read as
    // one sequence rather than two conflicting paths.
    const settled = apply ? toOrgDir : fromOrgDir;
    if (renameOrg && safeExistsSync(path.join(settled, fromSlug))) {
      moves.push({
        kind: 'organization_state',
        from: relative(rootDir, path.join(toOrgDir, fromSlug)),
        to: relative(rootDir, path.join(toOrgDir, toSlug)),
      });
      if (apply) safeMoveSync(path.join(settled, fromSlug), path.join(settled, toSlug));
      organizationRenamed = toSlug;
    }
    for (const file of walkFiles(settled)) {
      if (!file.endsWith('.json')) continue;
      rewrites.push(
        ...rewriteJsonFields(file, ['tenant_slug', 'tenant_id'], fromSlug, toSlug, rootDir, apply)
      );
      if (renameOrg) {
        rewrites.push(
          ...rewriteJsonFields(file, ['organization_id'], fromSlug, toSlug, rootDir, apply)
        );
      }
    }
  }

  // 3. Project records and mission state carry the containment chain.
  for (const dir of [
    runtimeStatePath('organization.projectsRoot').physicalPath,
    'active/missions',
  ]) {
    for (const file of walkFiles(path.join(rootDir, dir))) {
      if (!file.endsWith('.json')) continue;
      rewrites.push(...rewriteJsonFields(file, ['tenant_slug'], fromSlug, toSlug, rootDir, apply));
      if (renameOrg) {
        rewrites.push(
          ...rewriteJsonFields(file, ['organization_id'], fromSlug, toSlug, rootDir, apply)
        );
      }
    }
  }

  // 4. Customer stance overlay, if the tenant has one.
  const fromOverlay = path.join(rootDir, 'customer', fromSlug);
  if (safeExistsSync(fromOverlay)) {
    const toOverlay = path.join(rootDir, 'customer', toSlug);
    moves.push({
      kind: 'customer_overlay',
      from: relative(rootDir, fromOverlay),
      to: relative(rootDir, toOverlay),
    });
    if (apply) {
      // The overlay holds the tenant's audit mirror. Moving it under the audit
      // chain lock keeps every append on one side of the move, and the marker
      // records where: mirror reconcile counts the old slug's earlier entries
      // as the new slug's (see audit_mirror_reconcile.ts).
      withAuditChainLock(() => {
        safeMoveSync(fromOverlay, toOverlay);
        mirrorMovedId = auditChain.recordHeld(mirrorMovedEntry).id;
      });
    }
  }

  // 5. Profile last: it is the registry entry, so it flips only once the
  //    storage it points at has already moved.
  const profile: TenantProfile = {
    ...current,
    tenant_slug: toSlug,
    // tenant_id is identity, not location — see the note at the top.
    tenant_id: current.tenant_id || fromSlug,
    display_name: input.displayName?.trim() || current.display_name,
    knowledge_root: defaultTenantKnowledgeRoot(toSlug),
    metadata: {
      ...(current.metadata || {}),
      previous_slug: fromSlug,
      previous_slugs: [...previousSlugs(current), fromSlug],
      // The move markers this tenant's renames wrote. Mirror reconcile trusts
      // a marker only by these ids, so a marker recorded by anything else —
      // even one naming a rename in the history above — is never followed.
      ...(mirrorMovedId
        ? { [AUDIT_MIRROR_MOVE_IDS_KEY]: [...auditMirrorMoveIds(current), mirrorMovedId] }
        : {}),
    },
  };
  const fromProfilePath = tenantProfilePath(fromSlug, options);
  const toProfilePath = tenantProfilePath(toSlug, options);
  moves.push({
    kind: 'profile',
    from: relative(rootDir, fromProfilePath),
    to: relative(rootDir, toProfilePath),
  });
  if (apply) {
    writeTenantProfile(profile, options);
    if (safeExistsSync(fromProfilePath))
      safeMoveSync(fromProfilePath, `${fromProfilePath}.renamed`);
  }

  // 6. Whatever still says the old slug is reported, never rewritten. Prose,
  //    file names, and design assets are decisions, not mechanics.
  const needle = fromSlug;
  const residual = new Set<string>();
  if (input.scanResidual !== false)
    for (const root of RENAME_SCAN_ROOTS) {
      for (const file of walkFiles(path.join(rootDir, root))) {
        if (!RENAME_SCAN_EXTENSIONS.includes(path.extname(file))) continue;
        if (path.basename(file).includes(needle)) {
          residual.add(relative(rootDir, file));
          continue;
        }
        let text: string;
        try {
          text = safeReadFile(file, { encoding: 'utf8' }) as string;
        } catch {
          continue;
        }
        if (text.includes(needle)) residual.add(relative(rootDir, file));
      }
    }

  if (apply) {
    auditChain.record({
      agentId: actorId,
      action: 'tenant.rename',
      operation: `tenant:${fromSlug}->${toSlug}`,
      result: 'completed',
      tenantSlug: toSlug,
      metadata: {
        previous_slug: fromSlug,
        moves: moves.length,
        rewrites: rewrites.length,
        residual_references: residual.size,
      },
    });
  }

  return {
    status: apply ? 'applied' : 'dry-run',
    from_slug: fromSlug,
    to_slug: toSlug,
    profile,
    moves,
    rewrites,
    residual_references: [...residual].sort(),
    ...(organizationRenamed ? { organization_renamed: organizationRenamed } : {}),
  };
}
