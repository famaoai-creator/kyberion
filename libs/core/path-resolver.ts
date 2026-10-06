import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawExistsSync, rawReadTextFile, rawReaddir } from './fs-primitives.js';
import { assertSafeRepositoryPath as assertRepositoryPath } from '#repository-path-boundary';
import { isValidTenantSlug } from './foundation/scope.js';
import { getProcessEnv } from './foundation/process-env.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';

/**
 * Path Resolver Utility v4.0 (Protected VFS Edition)
 * Robust directory mapping with metadata for Deep Sandboxing.
 */

function findProjectRoot(startDir: string): string {
  // (d) Explicit override wins — robust for sub-directory / non-standard cwd execution.
  const envRoot = getProcessEnv('KYBERION_ROOT');
  if (envRoot && rawExistsSync(path.join(envRoot, 'package.json'))) {
    return path.resolve(envRoot);
  }
  return findRepositoryRoot(startDir) ?? process.cwd();
}

function findRepositoryRoot(startDir: string): string | undefined {
  let current = startDir;
  while (current !== path.parse(current).root) {
    const hasRootMarker =
      rawExistsSync(path.join(current, 'AGENTS.md')) ||
      rawExistsSync(path.join(current, 'pnpm-workspace.yaml'));
    if (
      rawExistsSync(path.join(current, 'package.json')) &&
      hasRootMarker &&
      (rawExistsSync(path.join(current, 'libs/actuators')) ||
        rawExistsSync(path.join(current, 'knowledge')))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return undefined;
}

const PROJECT_ROOT_DIR = findProjectRoot(process.cwd());
/** The checkout that contains this module (source or bundled dist), independent of KYBERION_ROOT. */
const CODE_REPOSITORY_ROOT = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return findRepositoryRoot(here) ?? '';
  } catch {
    return '';
  }
})();
const ACTIVE_ROOT = path.join(PROJECT_ROOT_DIR, 'active');
const ACTIVE_SHARED_ROOT = path.join(ACTIVE_ROOT, 'shared');
const KNOWLEDGE_ROOT = path.join(PROJECT_ROOT_DIR, 'knowledge');
const SCRIPTS_ROOT = path.join(PROJECT_ROOT_DIR, 'scripts');
const VAULT_ROOT = path.join(PROJECT_ROOT_DIR, 'vault');
const VISION_ROOT = path.join(PROJECT_ROOT_DIR, 'vision');
const INDEX_PATHS = [path.join(KNOWLEDGE_ROOT, 'product/orchestration/global_actuator_index.json')];
const MISSION_MANAGEMENT_CONFIG_PATH = path.join(
  KNOWLEDGE_ROOT,
  'product/governance/mission-management-config.json'
);

export function assertSafeRepositoryPath(
  filePath: string,
  options: {
    allowMissingLeaf?: boolean;
    allowSymlinkLeaf?: boolean;
    rootDir?: string;
  } = {}
): string {
  return assertRepositoryPath(filePath, {
    ...options,
    rootDir: options.rootDir ?? PROJECT_ROOT_DIR,
  });
}

/**
 * Path-resolver bootstrap cannot import secure-io or the governed catalog
 * without recreating their initialization cycle. Keep its raw config probe
 * narrow and apply the same repo-relative path contract as the governed
 * mission-management loader before using any directory value.
 */
export function isSafeMissionManagementPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  if (value.split(/[\\/]/u).some((segment) => segment === '..')) return false;
  const resolved = path.resolve(PROJECT_ROOT_DIR, value);
  const relative = path.relative(PROJECT_ROOT_DIR, resolved);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

type MissionTier = 'personal' | 'confidential' | 'public';

function readConfiguredMissionSubPath(tier: MissionTier | 'archive'): string | undefined {
  if (!rawExistsSync(MISSION_MANAGEMENT_CONFIG_PATH)) return undefined;
  try {
    const config = parseSafeJsonInput(
      rawReadTextFile(MISSION_MANAGEMENT_CONFIG_PATH),
      'mission management config'
    ) as {
      directories?: Record<string, unknown>;
    };
    const candidate = config.directories?.[tier];
    return isSafeMissionManagementPath(candidate) ? candidate : undefined;
  } catch (_) {
    return undefined;
  }
}

export function rootDir() {
  return PROJECT_ROOT_DIR;
}

/**
 * Validate a repository-local resource without allowing an existing path
 * component to be a symbolic link. This lives with the bootstrap path
 * resolver so policy-engine can validate its own input without importing
 * secure-io (which imports policy-engine during secure-io bootstrap).
 */
export function knowledge(subPath = '') {
  return path.join(KNOWLEDGE_ROOT, subPath);
}
export function active(subPath = '') {
  return path.join(ACTIVE_ROOT, subPath);
}
export function scripts(subPath = '') {
  return path.join(SCRIPTS_ROOT, subPath);
}
export function vault(subPath = '') {
  return path.join(VAULT_ROOT, subPath);
}
export function vision(subPath = '') {
  return path.join(VISION_ROOT, subPath);
}
export function capabilityAssets(subPath = '') {
  return path.join(KNOWLEDGE_ROOT, 'product/capability-assets', subPath);
}
/**
 * Live operational subtrees a Vitest run must never write to: delivery
 * outboxes (a running daemon would send fixture messages), audit evidence,
 * ops alerts, inboxes and peer mailboxes. Under Vitest, paths below these
 * prefixes resolve into a per-worker sandbox instead — reads and writes
 * alike, so code under test still round-trips through the same API.
 * Same pattern as approvalStoreRoots(); tests/vitest-active-leak-guard.ts
 * reports anything still leaking.
 */
const VITEST_LIVE_SUBTREES = [
  'shared/coordination/channels/',
  'shared/observability/channels/',
  'shared/logs/audit/',
  'audit/',
  'shared/observability/ops-alerts.jsonl',
  'shared/inbox/',
  'shared/runtime/dot-inbox.jsonl',
  'shared/runtime/peer-messaging/',
  // Internal runtime state a full test run would otherwise leave in the
  // operator's tree.
  'shared/runtime/task-sessions/',
  'shared/runtime/work-coordination/',
  'shared/observability/work-coordination/',
  'shared/runtime/feedback-loop/',
  'shared/runtime/tenants/',
  'shared/runtime/service-receipts/',
  'shared/logs/traces/',
  'shared/coordination/orchestration/',
  'shared/coordination/agent-runtime/',
  'shared/coordination/connection-reviews/',
  'shared/coordination/deliverable-reviews/',
  'shared/coordination/chronos/',
  'shared/observability/chronos/',
  'shared/observability/peer-messaging/',
  'shared/observability/mission-control/',
  'shared/observability/protocol-services/',
  'shared/logs/worker-events/',
  'shared/logs/agent-runtime-supervisor/',
  'shared/exports/intent-contract-memory-sync/',
  'shared/runtime/pipeline-runs/',
  'shared/runtime/run-graphs/',
  'shared/runtime/artifacts/',
  'shared/runtime/distill-candidates/',
  'shared/runtime/reports/',
  'shared/runtime/service-bindings/',
  'shared/runtime/health/',
  'shared/runtime/state/',
  'shared/runtime/reasoning-failover-events.jsonl',
];
export const VITEST_LIVE_SANDBOX_ROOT = 'active/shared/runtime/vitest-live';

/** Map an absolute path inside a live subtree to the Vitest sandbox; other paths pass through. */
export function vitestLivePath(absolutePath: string): string {
  if (!getProcessEnv('VITEST')) return absolutePath;
  // Only the checkout this code runs from holds live state; a fixture root
  // (KYBERION_ROOT pointed at a temp tree, in this process or a spawned child)
  // is already isolated and must resolve identically in parent and child.
  if (PROJECT_ROOT_DIR !== CODE_REPOSITORY_ROOT) return absolutePath;
  const relative = path.relative(ACTIVE_ROOT, absolutePath).split(path.sep).join('/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
  const hit = VITEST_LIVE_SUBTREES.some((prefix) =>
    prefix.endsWith('/') ? `${relative}/`.startsWith(prefix) : relative === prefix
  );
  if (!hit) return absolutePath;
  const pool = (getProcessEnv('VITEST_POOL_ID') || '0').replace(/[^\w-]/g, '');
  return path.join(PROJECT_ROOT_DIR, VITEST_LIVE_SANDBOX_ROOT, `pool-${pool}`, relative);
}

export function shared(subPath = '') {
  return vitestLivePath(path.join(ACTIVE_SHARED_ROOT, subPath));
}
export function sharedTmp(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'tmp');
  return path.join(base, subPath);
}

export type VolatileScope = 'session' | 'mission' | 'project' | 'personal' | 'tenant' | 'global';
export type VolatileCadence = 'resident' | 'daily' | 'weekly' | 'adhoc-ttl';

/**
 * Resolves the physical path for a volatile knowledge face.
 * Scope × cadence determine the canonical location under active/.
 *
 * @param scope   - Volatile scope (session/mission/project/personal/tenant/global)
 * @param ref     - Scope reference: mission-id, project-id, tenant-slug, session-id, or null
 * @param opts    - Optional: cadence and periodKey (YYYY-MM-DD or YYYY-Www)
 * @param opts.cadence   - Temporal cycle (defaults to 'resident')
 * @param opts.periodKey - Period key for daily/weekly faces
 * @param opts.tier      - Data tier (defaults to 'confidential')
 */
export function volatile(
  scope: VolatileScope,
  ref: string | null = null,
  opts: {
    cadence?: VolatileCadence;
    periodKey?: string;
    tier?: 'personal' | 'confidential' | 'public';
  } = {}
): string {
  const cadence = opts.cadence ?? 'resident';
  const tier = opts.tier ?? 'confidential';
  const normalRef = ref ? normalizePathSegment(ref, 'shared') : null;

  switch (scope) {
    case 'session': {
      const sessionId = normalRef || 'default-session';
      return path.join(ACTIVE_SHARED_ROOT, 'runtime', 'session', sessionId);
    }
    case 'mission': {
      if (!normalRef) throw new Error('volatile(mission) requires a mission ref');
      const missionPath =
        findMissionPath(normalRef) ?? path.join(ACTIVE_ROOT, 'missions', tier, normalRef);
      return missionPath;
    }
    case 'project': {
      if (!normalRef) throw new Error('volatile(project) requires a project ref');
      return path.join(ACTIVE_ROOT, 'projects', tier, normalRef);
    }
    case 'personal': {
      const personalBase = path.join(ACTIVE_ROOT, 'personal');
      if (cadence === 'daily' && opts.periodKey) {
        return path.join(personalBase, 'journal', opts.periodKey + '.md');
      }
      if (cadence === 'weekly' && opts.periodKey) {
        return path.join(personalBase, 'weekly', opts.periodKey + '.md');
      }
      if (cadence === 'daily') {
        return path.join(personalBase, 'today', 'TODO.md');
      }
      return personalBase;
    }
    case 'tenant': {
      if (!normalRef) throw new Error('volatile(tenant) requires a tenant slug ref');
      return path.join(ACTIVE_ROOT, 'projects', tier, normalRef);
    }
    case 'global': {
      return ACTIVE_SHARED_ROOT;
    }
    default:
      throw new Error(`Unknown volatile scope: ${scope}`);
  }
}
export function sharedExports(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'exports');
  return path.join(base, subPath);
}

export function sharedLogsAudit(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'logs', 'audit');
  return path.join(base, subPath);
}

export function sharedLogsProcess(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'logs', 'process');
  return path.join(base, subPath);
}

export function sharedLogsSurfaces(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'logs', 'surfaces');
  return path.join(base, subPath);
}

export function sharedLogsTraces(subPath = '') {
  const base = path.join(ACTIVE_SHARED_ROOT, 'logs', 'traces');
  return path.join(base, subPath);
}

export function isProtected(filePath: string) {
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(KNOWLEDGE_ROOT)) return true;
  if (resolved.startsWith(VAULT_ROOT)) return true;
  if (resolved.startsWith(VISION_ROOT)) return true;
  if (resolved.startsWith(SCRIPTS_ROOT) && !resolved.includes('active')) return true;
  return false;
}

export function capabilityDir(capabilityName: string) {
  const indexPath = INDEX_PATHS.find((candidate) => rawExistsSync(candidate));
  if (!indexPath) return path.join(PROJECT_ROOT_DIR, 'libs/actuators', capabilityName);
  const index = parseSafeJsonInput(rawReadTextFile(indexPath), 'actuator index') as {
    actuators?: unknown;
    s?: unknown;
    skills?: unknown;
  };
  const capabilityList = [index.actuators, index.s, index.skills].find(Array.isArray) ?? [];
  const capability = capabilityList.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return (record.n || record.name) === capabilityName;
  });

  if (
    capability &&
    typeof capability === 'object' &&
    !Array.isArray(capability) &&
    typeof (capability as Record<string, unknown>).path === 'string'
  ) {
    return path.join(PROJECT_ROOT_DIR, (capability as Record<string, unknown>).path as string);
  }

  // Actuator fallback
  const actuatorPath = path.join(PROJECT_ROOT_DIR, 'libs/actuators', capabilityName);
  if (rawExistsSync(actuatorPath)) return actuatorPath;

  return path.join(PROJECT_ROOT_DIR, capabilityName);
}

export const skillDir = capabilityDir;

export function capabilityEntry(capabilityName: string) {
  return path.join(
    PROJECT_ROOT_DIR,
    'dist',
    'libs',
    'actuators',
    capabilityName,
    'src',
    'index.js'
  );
}

export function missionDir(
  missionId: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential',
  tenantSlug?: string
) {
  assertMissionIdArgument(missionId);
  const subPath = readConfiguredMissionSubPath(tier) || 'active/missions';

  const dir = tenantSlug
    ? path.join(PROJECT_ROOT_DIR, subPath, normalizeTenantWorkspaceSegment(tenantSlug), missionId)
    : path.join(PROJECT_ROOT_DIR, subPath, missionId);
  return dir;
}

/**
 * Validate identifiers before they become filesystem segments. In particular,
 * CLI flags such as `--HELP` must never materialize as mission directories.
 * This resolver is intentionally read-only; writers must create the returned
 * parent through secure-io after their own authority check.
 */
export function assertMissionIdArgument(missionId: string): void {
  const value = String(missionId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value) || value.startsWith('--')) {
    throw new Error(`[path-resolver] invalid mission id '${missionId}'`);
  }
}

const VOLATILE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9._])?$/;

/**
 * Strict id check for state keyed by a session or mission id. volatile()
 * normalizes refs for backward compatibility, so `a/b` and `a-b` share a
 * directory; callers keying sensitive state must validate and reject instead.
 */
export function assertVolatileId(kind: 'session' | 'mission', value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (kind === 'mission') {
    assertMissionIdArgument(id);
    return id;
  }
  if (!VOLATILE_SESSION_ID.test(id) || id.includes('..')) {
    throw new Error(`[path-resolver] invalid session id '${String(value)}'`);
  }
  return id;
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function normalizePathSegment(value: string, fallback = 'shared') {
  return (
    trimDashes(
      String(value || '')
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
    ) || fallback
  );
}

function normalizeTenantWorkspaceSegment(value = 'shared'): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'shared') return normalized;
  if (!isValidTenantSlug(normalized)) {
    throw new Error(`[path-resolver] invalid tenant slug '${value}'`);
  }
  return normalized;
}

/**
 * Returns the workspace directory for a project.
 * Path: active/projects/{tier}/{tenantOrShared}/{projectId}/
 */
export function projectWorkspaceDir(
  projectId: string,
  tier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug = 'shared',
  rootDir = PROJECT_ROOT_DIR
): string {
  const dir = path.join(
    path.resolve(rootDir, 'active'),
    'projects',
    tier,
    normalizeTenantWorkspaceSegment(tenantSlug),
    normalizePathSegment(projectId, 'project')
  );
  return dir;
}

/**
 * Returns the project OS scaffold directory for a project.
 * Path: active/projects/{tier}/{tenantOrShared}/{projectId}/project-os/
 */
export function projectOsDir(
  projectId: string,
  tier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug = 'shared',
  rootDir = PROJECT_ROOT_DIR
): string {
  const dir = path.join(projectWorkspaceDir(projectId, tier, tenantSlug, rootDir), 'project-os');
  return dir;
}

/**
 * Returns the live project operational state directory.
 * Path: active/projects/{tier}/{tenantOrShared}/{projectId}/state/
 */
export function projectStateDir(
  projectId: string,
  tier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug = 'shared',
  rootDir = PROJECT_ROOT_DIR
): string {
  const dir = path.join(projectWorkspaceDir(projectId, tier, tenantSlug, rootDir), 'state');
  return dir;
}

/**
 * Returns the workspace directory for an organization operating model.
 * Path: active/organizations/{tier}/{tenantOrShared}/{organizationId}/
 */
export function organizationWorkspaceDir(
  organizationId: string,
  tier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug = 'shared',
  rootDir = PROJECT_ROOT_DIR
): string {
  const dir = path.join(
    path.resolve(rootDir, 'active'),
    'organizations',
    tier,
    normalizeTenantWorkspaceSegment(tenantSlug),
    normalizePathSegment(organizationId, 'organization')
  );
  return dir;
}

/**
 * Returns the live organization operational state directory.
 * Path: active/organizations/{tier}/{tenantOrShared}/{organizationId}/state/
 */
export function organizationStateDir(
  organizationId: string,
  tier: 'personal' | 'confidential' | 'public' = 'public',
  tenantSlug = 'shared',
  rootDir = PROJECT_ROOT_DIR
): string {
  const dir = path.join(
    organizationWorkspaceDir(organizationId, tier, tenantSlug, rootDir),
    'state'
  );
  return dir;
}

/**
 * Returns where a finished mission lives once archived
 * (mission-management-config.json `directories.archive`, default
 * `active/archive/missions/<ID>`). `findMissionPath` deliberately does not
 * search here: archived missions are read-only history, looked up explicitly.
 */
export function archivedMissionsRoot(): string {
  return path.join(
    PROJECT_ROOT_DIR,
    readConfiguredMissionSubPath('archive') || 'active/archive/missions'
  );
}

export function archivedMissionDir(missionId: string): string {
  assertMissionIdArgument(missionId);
  return path.join(archivedMissionsRoot(), missionId.toUpperCase());
}

/**
 * Returns the path to the audit directory for a given mission (tier-aware).
 */
export function missionAuditDir(
  missionId: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential'
) {
  const missionPath =
    findMissionPath(missionId) ?? path.join(ACTIVE_ROOT, 'missions', tier, missionId);
  const dir = path.join(missionPath, 'audit');
  return dir;
}

/**
 * Returns the path to the evidence directory for a given mission.
 */
export function missionEvidenceDir(missionId: string) {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return null;
  const dir = path.join(missionPath, 'evidence');
  return dir;
}

/**
 * Returns the mission directory scoped to a specific tenant.
 * Path: active/missions/{tier}/{tenantSlug}/{missionId}/
 * Used when creating tenant-bound missions to make tenant ownership
 * visible in the filesystem (not just inside mission-state.json).
 */
export function tenantMissionDir(
  missionId: string,
  tenantSlug: string,
  tier: 'personal' | 'confidential' | 'public' = 'confidential'
): string {
  assertMissionIdArgument(missionId);
  const subPath = readConfiguredMissionSubPath(tier) || 'active/missions';
  const dir = path.join(
    PROJECT_ROOT_DIR,
    subPath,
    normalizeTenantWorkspaceSegment(tenantSlug),
    missionId
  );
  return dir;
}

function currentTenantSlug(): string | undefined {
  const value = String(getProcessEnv('KYBERION_TENANT') || '')
    .trim()
    .toLowerCase();
  return isValidTenantSlug(value) ? value : undefined;
}

function isMissionDirectory(candidate: string): boolean {
  // A mission-local .git alone is not sufficient: archived/exported shells can
  // retain .git while lacking mission state and must not shadow a real mission
  // path. Tests and early lifecycle phases may legitimately create the mission
  // directory before mission-state.json is materialized, so do not require the
  // state file here; reject only the git-only shell shape.
  if (!rawExistsSync(candidate)) return false;
  try {
    const entries = rawReaddir(candidate);
    return !entries.includes('.git') || entries.some((entry) => entry !== '.git');
  } catch (_) {
    return false;
  }
}

/**
 * Locates an existing mission from its own record (registered by owner-scope,
 * which sits above this module). Returns the mission directory, or undefined
 * when no mission state is visible; throws when the id is ambiguous.
 */
export type MissionLocator = (missionId: string) => string | undefined;

const MISSION_LOCATOR = Symbol.for('kyberion.pathResolver.missionLocator');

export function registerMissionLocator(locator: MissionLocator): void {
  (globalThis as Record<symbol, unknown>)[MISSION_LOCATOR] = locator;
}

function registeredMissionLocator(): MissionLocator | undefined {
  return (globalThis as Record<symbol, unknown>)[MISSION_LOCATOR] as MissionLocator | undefined;
}

/**
 * Finds a mission directory. An existing mission (one with mission-state.json)
 * is located from its own record via the registered locator: the same answer
 * as resolveOwnerScope, across tiers and tenant partitions. The directory scan
 * below then only finds a pre-materialized mission (no state yet), searching
 * personal -> confidential -> public.
 */
let locatingMission = false;

/** Same `[CODE] what — why | next: remedy` shape as OwnerScopeError. */
function missionNotVisibleError(missionId: string): Error {
  const error = new Error(
    `[OWNER_NOT_VISIBLE] mission ${missionId} exists but is not resolvable by this process — ` +
      'its state belongs to another tenant or disagrees with its directory | ' +
      'next: run under the owning tenant, or repair the mission state'
  );
  (error as Error & { code: string }).code = 'OWNER_NOT_VISIBLE';
  return error;
}

export function findMissionPath(missionId: string): string | null {
  assertMissionIdArgument(missionId);
  // The locator reads through secure-io, whose permission check resolves the
  // caller identity, which may look a mission up again. That nested lookup
  // takes the plain scan (the behavior before the locator existed) instead
  // of re-entering the locator, which would recurse without bound.
  const locator = locatingMission ? undefined : registeredMissionLocator();
  if (locator) {
    locatingMission = true;
    let located: string | undefined;
    try {
      located = locator(missionId);
    } finally {
      locatingMission = false;
    }
    if (located) return located;
  }
  // With a locator, a canonical (upper-case) directory holding a state the
  // locator did not resolve belongs to a scope this process may not see, or is
  // inconsistent. Returning null would let a caller create a second copy, so
  // it fails closed. A stateless (pre-materialized) directory, a non-canonical
  // (lower-case) name the locator does not search, and the legacy unpartitioned
  // root keep the plain-scan behavior.
  const canonical = missionId.toUpperCase();
  const accept = (candidate: string, legacy = false): boolean => {
    if (!isMissionDirectory(candidate)) return false;
    if (!locator || legacy || path.basename(candidate) !== canonical) return true;
    if (!rawExistsSync(path.join(candidate, 'mission-state.json'))) return true;
    throw missionNotVisibleError(missionId);
  };
  const tiers: MissionTier[] = ['personal', 'confidential', 'public'];

  for (const tier of tiers) {
    const subPath = readConfiguredMissionSubPath(tier);
    if (subPath) {
      const tenant = currentTenantSlug();
      if (tenant) {
        const scopedPath = path.join(PROJECT_ROOT_DIR, subPath, tenant, missionId);
        if (accept(scopedPath)) return scopedPath;
      }
      const fullPath = path.join(PROJECT_ROOT_DIR, subPath, missionId);
      if (accept(fullPath)) return fullPath;
    }
  }

  // Legacy fallback
  const legacyPath = path.join(ACTIVE_ROOT, 'missions', missionId);
  if (accept(legacyPath, true)) return legacyPath;

  return null;
}

export function resolve(logicalPath: string) {
  if (!logicalPath) return PROJECT_ROOT_DIR;
  if (logicalPath.startsWith('capability://')) {
    const parts = logicalPath.slice(13).split('/');
    return path.join(capabilityDir(parts[0]), parts.slice(1).join('/'));
  }
  if (logicalPath.startsWith('skill://')) {
    const parts = logicalPath.slice(8).split('/');
    return path.join(capabilityDir(parts[0]), parts.slice(1).join('/'));
  }
  if (logicalPath.startsWith('active/shared/')) {
    return shared(logicalPath.replace('active/shared/', ''));
  }
  return vitestLivePath(
    path.isAbsolute(logicalPath) ? logicalPath : path.resolve(PROJECT_ROOT_DIR, logicalPath)
  );
}

export function rootResolve(relativePath: string) {
  return vitestLivePath(
    path.isAbsolute(relativePath) ? relativePath : path.join(PROJECT_ROOT_DIR, relativePath)
  );
}

/**
 * (a) Convert an absolute path under the project root to a portable, repo-relative path.
 * Call this BEFORE persisting any path into a registry / ADF / JSON so stored paths never
 * embed a machine-specific prefix (e.g. a `<home>/<user>/...` absolute path). A path that is
 * already relative, or absolute but OUTSIDE the project root, is returned unchanged.
 */
export function toRepoRelative(targetPath: string): string {
  if (!targetPath || !path.isAbsolute(targetPath)) return targetPath;
  const rel = path.relative(PROJECT_ROOT_DIR, targetPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : targetPath;
}

/**
 * (b) Normalize a stored path for portability. Relativizes an absolute path that lives
 * under the project root; flags a foreign absolute path (outside the root) so callers can
 * warn instead of silently persisting a machine-specific path. Relative paths pass through.
 */
export function normalizeStoredPath(targetPath: string): { path: string; foreign: boolean } {
  if (!targetPath || !path.isAbsolute(targetPath)) return { path: targetPath, foreign: false };
  const rel = path.relative(PROJECT_ROOT_DIR, targetPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return { path: rel, foreign: false };
  return { path: targetPath, foreign: true };
}

// Named export for older scripts that import * as pathResolver
export const pathResolver = {
  rootDir: () => PROJECT_ROOT_DIR,
  activeRoot: () => ACTIVE_ROOT,
  knowledgeRoot: () => KNOWLEDGE_ROOT,
  scriptsRoot: () => SCRIPTS_ROOT,
  vaultRoot: () => VAULT_ROOT,
  visionRoot: () => VISION_ROOT,
  knowledge,
  active,
  scripts,
  vault,
  vision,
  capabilityAssets,
  shared,
  sharedTmp,
  sharedExports,
  sharedLogsAudit,
  sharedLogsProcess,
  sharedLogsSurfaces,
  sharedLogsTraces,
  isProtected,
  capabilityEntry,
  capabilityDir,
  skillDir,
  missionDir,
  assertMissionIdArgument,
  assertVolatileId,
  projectWorkspaceDir,
  projectOsDir,
  projectStateDir,
  organizationWorkspaceDir,
  organizationStateDir,
  missionAuditDir,
  missionEvidenceDir,
  tenantMissionDir,
  findMissionPath,
  archivedMissionsRoot,
  archivedMissionDir,
  volatile,
  resolve,
  rootResolve,
  vitestLivePath,
  toRepoRelative,
  normalizeStoredPath,
};
