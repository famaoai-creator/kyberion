import { appendJsonLine, readJson, readJsonIfPresent, readJsonLines } from '../foundation/json.js';
import { isRecord } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { withExecutionContext } from '../authority.js';
import {
  RETENTION_ARTIFACT_CLASSES,
  type RetentionArtifactClass,
} from '../storage-retention-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import {
  STORAGE_FLOOR_ROOTS,
  SYSTEM_PARTITION,
  classifyStorageFloorPath,
  storagePartitionSegments,
} from '../storage-layout.js';
import type { ArtifactKind } from './artifact-registry.js';
import {
  createArtifactRecord,
  loadArtifactRecord,
  saveArtifactRecord,
  type ArtifactRecord,
} from './artifact-record.js';

export type GovernedArtifactRole =
  | 'slack_bridge'
  | 'chronos_gateway'
  | 'surface_runtime'
  | 'mission_controller'
  | 'infrastructure_sentinel'
  | 'sovereign_concierge';

// Kept as an explicit literal union: the role assumption analysis
// (scripts/analyze_role_assumptions.ts) resolves it without the TS lib. The
// record below makes the runtime list exhaustive and exact at compile time.
const GOVERNED_ARTIFACT_ROLE_SET: Record<GovernedArtifactRole, true> = {
  slack_bridge: true,
  chronos_gateway: true,
  surface_runtime: true,
  mission_controller: true,
  infrastructure_sentinel: true,
  sovereign_concierge: true,
};

/**
 * The store-writer roles governed artifacts are written as. The surface
 * coordination role map schema enumerates exactly these values
 * (surface-coordination-role-map.test.ts keeps them equal), so data can never
 * name a role this type does not cover.
 */
export const GOVERNED_ARTIFACT_ROLES = Object.keys(
  GOVERNED_ARTIFACT_ROLE_SET
) as readonly GovernedArtifactRole[];

function withRole<T>(role: GovernedArtifactRole, fn: () => T): T {
  return withExecutionContext(role, fn);
}

export function isGovernedArtifactPath(logicalPath: string): boolean {
  if (logicalPath.startsWith('active/shared/coordination/')) return true;
  if (logicalPath.startsWith('active/shared/observability/')) return true;
  if (logicalPath.startsWith('active/shared/runtime/')) return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/coordination/'))
    return true;
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/observability/'))
    return true;
  return false;
}

export function resolveGovernedArtifactPath(logicalPath: string): string {
  if (!isGovernedArtifactPath(logicalPath)) {
    throw new Error(
      `Artifact path is outside governed coordination/observability scopes: ${logicalPath}`
    );
  }
  return assertSafeRepositoryPath(pathResolver.resolve(logicalPath), {
    allowMissingLeaf: true,
  });
}

function ensureRegularGovernedArtifactFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`governed artifact must be a regular file: ${filePath}`);
  }
}

export function ensureGovernedArtifactDir(role: GovernedArtifactRole, logicalDir: string): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalDir);
    if (!safeExistsSync(resolved)) safeMkdir(resolved, { recursive: true });
    return resolved;
  });
}

export function writeGovernedArtifactJson(
  role: GovernedArtifactRole,
  logicalPath: string,
  value: unknown
): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    const dir = path.dirname(resolved);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    ensureRegularGovernedArtifactFile(resolved);
    safeWriteFile(logicalPath, JSON.stringify(value, null, 2));
    return resolved;
  });
}

export function appendGovernedArtifactJsonl(
  role: GovernedArtifactRole,
  logicalPath: string,
  value: unknown
): string {
  return withRole(role, () => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    const dir = path.dirname(resolved);
    if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
    ensureRegularGovernedArtifactFile(resolved);
    appendJsonLine(logicalPath, value);
    return resolved;
  });
}

export function readGovernedArtifactJson<T>(logicalPath: string): T | null {
  const resolved = resolveGovernedArtifactPath(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  ensureRegularGovernedArtifactFile(resolved);
  return readJson<T>(resolved);
}

export function listGovernedArtifacts(logicalDir: string): string[] {
  const resolved = resolveGovernedArtifactPath(logicalDir);
  if (!safeExistsSync(resolved)) return [];
  return safeReaddir(resolved).sort();
}

// ---------------------------------------------------------------------------
// AL-02: scope-aware artifact placement (`writeScopedArtifact`)
//
// The scope hierarchy (tenant → project → mission → task → session) already
// governs placement (path-resolver) and access control (tier-guard); this API
// connects it to artifact writes so that every artifact lands in a canonical
// per-scope location under an `artifacts/<class>/` root, and is recorded in a
// scope-local `artifacts-index.jsonl` that later GC (AL-03/AL-04) can read to
// classify artifacts without stat-walking. It is the sanctioned alternative to
// the tmp-by-default habit (`sharedTmp(...)`), which is ratcheted by
// `tests/shared-tmp-ratchet.test.ts`.
// ---------------------------------------------------------------------------

export interface ScopedArtifactScope {
  /**
   * Platform-wide artifact owned by no tenant (health reports, platform cost
   * reports). Never carries tenant or personal data; cannot be combined with
   * another scope ref.
   */
  system?: true;
  tenant?: string;
  /**
   * Organization-owned artifact (digests, org-wide reports). Lands under the
   * organization workspace (`active/organizations/<tier>/<tenant|shared>/<org>/artifacts/`);
   * `tenant` refines placement.
   */
  organization?: string;
  project?: string;
  mission?: string;
  /** Task scope nests under its mission — `mission` is required with `task`. */
  task?: string;
  session?: string;
}

export type ScopedArtifactScopeKind =
  'task' | 'mission' | 'project' | 'session' | 'organization' | 'tenant' | 'system';

/**
 * Surface publication for a scoped artifact: also registers an ArtifactRecord
 * (`active/shared/runtime/artifacts/<id>.json`) so Chronos and other surfaces
 * list it in the deliverable inbox and can preview it through mission-asset.
 */
export interface ScopedArtifactPublication {
  kind: ArtifactKind;
  preview_text?: string;
  organization_id?: string;
  /**
   * Owning task session. ArtifactRecords must be owned by a project, mission,
   * organization or task session (artifact-ownership-record.schema.json);
   * tenant/system scoped artifacts name their task session here to be published.
   */
  task_session_id?: string;
  /**
   * Deterministic record id for a deliverable that is re-written in place
   * (e.g. a daily digest): a re-run updates the same ArtifactRecord instead
   * of registering a new one.
   */
  artifact_id?: string;
  metadata?: Record<string, unknown>;
}

export type ScopedArtifactFormat = 'json' | 'text' | 'buffer';

export interface WriteScopedArtifactInput {
  scope: ScopedArtifactScope;
  artifact_class: RetentionArtifactClass;
  /**
   * Artifact file name. May contain `/` subpath segments (e.g.
   * `tool-output/3-exec.log`); each segment is sanitized and traversal
   * segments are rejected.
   */
  name: string;
  content: unknown;
  /** Defaults: string → 'text', Buffer/Uint8Array → 'buffer', otherwise 'json'. */
  format?: ScopedArtifactFormat;
  /** Optional execution-context role, honored like writeGovernedArtifactJson. */
  role?: GovernedArtifactRole;
  /** Data tier for project/organization/tenant/mission placement. Defaults to 'confidential'. */
  tier?: 'personal' | 'confidential' | 'public';
  /** Register the artifact for surfaces (deliverable inbox). Omit for internal artifacts. */
  publish?: ScopedArtifactPublication;
}

export interface ScopedArtifactIndexEntry {
  name: string;
  artifact_class: RetentionArtifactClass;
  /** Repo-relative artifact path (portable — never machine-absolute). */
  path: string;
  scope: ScopedArtifactScope;
  scope_kind: ScopedArtifactScopeKind;
  written_at: string;
}

export interface WriteScopedArtifactResult {
  absolute_path: string;
  repo_relative_path: string;
  /** Absolute path of the scope-local artifacts-index.jsonl the write was recorded in. */
  index_path: string;
  scope_kind: ScopedArtifactScopeKind;
  /** ArtifactRecord id when the write was published for surfaces. */
  artifact_id?: string;
}

export const SCOPED_ARTIFACT_INDEX_FILENAME = 'artifacts-index.jsonl';

const SCOPED_ARTIFACT_INDEX_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/scoped-artifact-index-entry.schema.json'
);

/** Canonical catalog for persisted scope-local artifact index rows. */
export function scopedArtifactIndexCatalog(
  filePath: string
): GovernedCatalog<ScopedArtifactIndexEntry> {
  return defineCatalog<ScopedArtifactIndexEntry>({
    id: 'scoped-artifact-index-entry',
    path: filePath,
    schema: SCOPED_ARTIFACT_INDEX_SCHEMA_PATH,
  });
}

/** Reject a directory or symlink before a persisted artifact index is used. */
export function ensureRegularScopedArtifactIndex(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`scoped artifact index must be a regular file: ${filePath}`);
  }
}

/** Strip leading/trailing `-` in linear time (a `^-+|-+$` regex is polynomial on long dash runs). */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function sanitizeScopeSegment(value: string, label: string): string {
  const cleaned = trimDashes(
    String(value ?? '')
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
  );
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`writeScopedArtifact: invalid ${label} reference: ${JSON.stringify(value)}`);
  }
  return cleaned;
}

/**
 * Canonical directory name for a task's scoped artifacts
 * (`<missionDir>/artifacts/<class>/task-<taskId>/`). Exported so AL-03 GC
 * (`mission-artifact-closure.ts`) resolves the same directory a
 * `writeScopedArtifact` task-scope write produced, using the same sanitizer.
 */
export function scopedTaskArtifactDirName(taskId: string): string {
  return `task-${sanitizeScopeSegment(taskId, 'task')}`;
}

function sanitizeArtifactName(name: string): string {
  const segments = String(name ?? '')
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      const cleaned = trimDashes(seg.trim().replace(/[^a-zA-Z0-9._-]+/g, '-'));
      if (!cleaned || cleaned === '.' || cleaned === '..' || /^\.+$/.test(cleaned)) {
        throw new Error(
          `writeScopedArtifact: invalid artifact name segment: ${JSON.stringify(seg)}`
        );
      }
      return cleaned;
    });
  if (segments.length === 0) {
    throw new Error(`writeScopedArtifact: artifact name is empty: ${JSON.stringify(name)}`);
  }
  return segments.join('/');
}

/**
 * Fail-closed predicate for the scope-aware artifact roots. Parallel to
 * `isGovernedArtifactPath` (which stays narrowed to coordination/observability
 * scopes): a scoped artifact may only land inside an `artifacts/` subtree of a
 * canonical mission, project, organization, or runtime-session directory, or inside a
 * partition (system or tier/tenant) of the storage-layout artifact floor.
 */
export function isScopedArtifactPath(logicalPath: string): boolean {
  if (logicalPath.split(/[\\/]/u).includes('..')) return false;
  const floor = classifyStorageFloorPath(logicalPath);
  if (floor) {
    return (
      floor.floor === 'artifact' &&
      floor.partition.kind !== 'legacy' &&
      logicalPath.startsWith(`${STORAGE_FLOOR_ROOTS.artifact}/`)
    );
  }
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/artifacts/'))
    return true;
  if (logicalPath.startsWith('active/projects/') && logicalPath.includes('/artifacts/'))
    return true;
  if (logicalPath.startsWith('active/organizations/') && logicalPath.includes('/artifacts/'))
    return true;
  if (
    logicalPath.startsWith('active/shared/runtime/session/') &&
    logicalPath.includes('/artifacts/')
  ) {
    return true;
  }
  return false;
}

function persistedString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`scoped artifact index ${key} must be a non-empty string`);
  }
  return value;
}

/** Validate an artifacts-index row before lifecycle code treats it as typed state. */
export function parseScopedArtifactIndexEntry(value: unknown): ScopedArtifactIndexEntry {
  if (!isRecord(value)) throw new Error('scoped artifact index entry must be an object');
  persistedString(value, 'name');
  const artifactClass = persistedString(value, 'artifact_class');
  if (!RETENTION_ARTIFACT_CLASSES.includes(artifactClass as RetentionArtifactClass)) {
    throw new Error('scoped artifact index artifact_class is invalid');
  }
  const artifactPath = persistedString(value, 'path');
  if (!isScopedArtifactPath(artifactPath) || artifactPath.startsWith('/')) {
    throw new Error('scoped artifact index path is invalid');
  }
  const scope = value.scope;
  if (!isRecord(scope)) throw new Error('scoped artifact index scope is invalid');
  const scopeKeys = ['tenant', 'organization', 'project', 'mission', 'task', 'session'] as const;
  if (scope.system !== undefined && scope.system !== true) {
    throw new Error('scoped artifact index scope.system is invalid');
  }
  if (scope.system === undefined && !scopeKeys.some((key) => scope[key] !== undefined)) {
    throw new Error('scoped artifact index scope is empty');
  }
  for (const key of scopeKeys) {
    if (scope[key] !== undefined) persistedString(scope, key);
  }
  const scopeKind = persistedString(value, 'scope_kind');
  if (
    !['task', 'mission', 'project', 'session', 'organization', 'tenant', 'system'].includes(
      scopeKind
    )
  ) {
    throw new Error('scoped artifact index scope_kind is invalid');
  }
  const writtenAt = persistedString(value, 'written_at');
  if (!Number.isFinite(Date.parse(writtenAt))) {
    throw new Error('scoped artifact index written_at is invalid');
  }
  return value as unknown as ScopedArtifactIndexEntry;
}

function artifactFloorRoot(segments: string[]): string {
  return path.join(pathResolver.rootDir(), ...STORAGE_FLOOR_ROOTS.artifact.split('/'), ...segments);
}

/**
 * Resolve the `artifacts` root of a scope. Mission/project/session scopes own
 * an `artifacts/` subtree of their directory (an organization scope uses its
 * organization workspace); tenant and system scopes own a
 * partition of the storage-layout artifact floor
 * (`active/shared/artifacts/<tier>/<tenant>/` and `active/shared/artifacts/system/`).
 */
function resolveScopeArtifactsRoot(
  scope: ScopedArtifactScope,
  tier: 'personal' | 'confidential' | 'public'
): { artifactsRoot: string; kind: ScopedArtifactScopeKind } {
  if (scope.system !== undefined) {
    const others = (
      ['tenant', 'organization', 'project', 'mission', 'task', 'session'] as const
    ).filter((key) => scope[key] !== undefined);
    if (scope.system !== true || others.length > 0) {
      throw new Error(
        'writeScopedArtifact: system scope is platform-wide and cannot be combined with tenant/organization/project/mission/task/session'
      );
    }
    if (tier !== 'public') {
      throw new Error('writeScopedArtifact: system scope carries public-tier data only');
    }
    return {
      artifactsRoot: artifactFloorRoot(storagePartitionSegments(SYSTEM_PARTITION)),
      kind: 'system',
    };
  }
  if (scope.task !== undefined) {
    if (!scope.mission) {
      throw new Error('writeScopedArtifact: task scope requires a mission reference');
    }
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    const base = pathResolver.findMissionPath(mission) ?? pathResolver.missionDir(mission, tier);
    return { artifactsRoot: path.join(base, 'artifacts'), kind: 'task' };
  }
  if (scope.mission !== undefined) {
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    const base = pathResolver.findMissionPath(mission) ?? pathResolver.missionDir(mission, tier);
    return { artifactsRoot: path.join(base, 'artifacts'), kind: 'mission' };
  }
  if (scope.project !== undefined) {
    const project = sanitizeScopeSegment(scope.project, 'project');
    const tenant = scope.tenant ? sanitizeScopeSegment(scope.tenant, 'tenant') : 'shared';
    return {
      artifactsRoot: path.join(
        pathResolver.projectWorkspaceDir(project, tier, tenant),
        'artifacts'
      ),
      kind: 'project',
    };
  }
  if (scope.session !== undefined) {
    const session = sanitizeScopeSegment(scope.session, 'session');
    return {
      artifactsRoot: path.join(pathResolver.volatile('session', session), 'artifacts'),
      kind: 'session',
    };
  }
  if (scope.organization !== undefined) {
    const organization = sanitizeScopeSegment(scope.organization, 'organization');
    const tenant = scope.tenant ? sanitizeScopeSegment(scope.tenant, 'tenant') : 'shared';
    return {
      artifactsRoot: path.join(
        pathResolver.organizationWorkspaceDir(organization, tier, tenant),
        'artifacts'
      ),
      kind: 'organization',
    };
  }
  if (scope.tenant !== undefined) {
    let segments: string[];
    try {
      segments = storagePartitionSegments({ kind: 'tier', tier, tenant: scope.tenant });
    } catch {
      throw new Error(
        `writeScopedArtifact: invalid tenant reference: ${JSON.stringify(scope.tenant)}`
      );
    }
    return { artifactsRoot: artifactFloorRoot(segments), kind: 'tenant' };
  }
  throw new Error(
    'writeScopedArtifact: scope must name at least one of system/tenant/organization/project/mission/task/session'
  );
}

/**
 * Tier of an existing mission owner, read from its own state: a mission/task
 * write lands in that mission's directory, so its index entry and published
 * record must carry the mission's tier instead of a default.
 */
function existingMissionTier(
  scope: ScopedArtifactScope
): 'personal' | 'confidential' | 'public' | undefined {
  if (scope.system !== undefined || scope.mission === undefined) return undefined;
  const missionPath = pathResolver.findMissionPath(sanitizeScopeSegment(scope.mission, 'mission'));
  if (!missionPath) return undefined;
  try {
    const state = readJsonIfPresent<{ tier?: unknown }>(
      path.join(missionPath, 'mission-state.json')
    );
    if (state?.tier === 'personal' || state?.tier === 'confidential' || state?.tier === 'public') {
      return state.tier;
    }
  } catch {
    // Unreadable state: fall back to the directory layout below.
  }
  const relative = pathResolver.toRepoRelative(missionPath).split(path.sep).join('/');
  const match = relative.match(/^active\/missions\/(personal|confidential|public)\//u);
  if (match) return match[1] as 'personal' | 'confidential' | 'public';
  return relative.startsWith('knowledge/personal/') ? 'personal' : undefined;
}

function serializeScopedContent(content: unknown, format?: ScopedArtifactFormat): string | Buffer {
  const effective: ScopedArtifactFormat =
    format ??
    (typeof content === 'string'
      ? 'text'
      : Buffer.isBuffer(content) || content instanceof Uint8Array
        ? 'buffer'
        : 'json');
  if (effective === 'buffer') {
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    throw new Error("writeScopedArtifact: format 'buffer' requires Buffer/Uint8Array content");
  }
  if (effective === 'text') {
    return typeof content === 'string' ? content : String(content);
  }
  return JSON.stringify(content, null, 2);
}

/**
 * Write an artifact into its canonical scope-local location:
 *
 * - task:    `<missionDir>/artifacts/<class>/task-<task>/<name>` (requires mission)
 * - mission: `<missionDir>/artifacts/<class>/<name>`
 * - project: `<projectWorkspaceDir>/artifacts/<class>/<name>` (tenant refines placement)
 * - session: `active/shared/runtime/session/<session>/artifacts/<class>/<name>`
 * - organization: `active/organizations/<tier>/<tenant|shared>/<org>/artifacts/<class>/<name>`
 * - tenant:  `active/shared/artifacts/<tier>/<tenant>/<class>/<name>`
 * - system:  `active/shared/artifacts/system/<class>/<name>` (public tier only)
 *
 * Precedence when several refs are present:
 * task > mission > project > session > organization > tenant.
 * `system` stands alone. With `publish`, an ArtifactRecord is also registered
 * so surfaces (Chronos deliverable inbox, mission-asset preview) can list it.
 * Every write is appended to the scope-local `artifacts-index.jsonl` so
 * lifecycle GC (AL-03/AL-04) can classify artifacts by class without walking.
 * Fail-closed: the resolved path must satisfy `isScopedArtifactPath`.
 */
export function writeScopedArtifact(input: WriteScopedArtifactInput): WriteScopedArtifactResult {
  if (!RETENTION_ARTIFACT_CLASSES.includes(input.artifact_class)) {
    throw new Error(
      `writeScopedArtifact: invalid artifact_class ${JSON.stringify(input.artifact_class)} ` +
        `(expected one of ${RETENTION_ARTIFACT_CLASSES.join('/')})`
    );
  }
  const missionTier = existingMissionTier(input.scope);
  if (input.tier && missionTier && input.tier !== missionTier) {
    // The file lands in the mission's own directory; a different label would
    // make the index row and published record lie about its tier.
    throw new Error(
      `writeScopedArtifact: tier '${input.tier}' contradicts mission ${input.scope.mission} tier '${missionTier}'`
    );
  }
  const tier = input.tier ?? missionTier ?? (input.scope.system ? 'public' : 'confidential');
  const { artifactsRoot, kind } = resolveScopeArtifactsRoot(input.scope, tier);
  const name = sanitizeArtifactName(input.name);
  const targetDir =
    kind === 'task'
      ? path.join(
          artifactsRoot,
          input.artifact_class,
          scopedTaskArtifactDirName(input.scope.task as string)
        )
      : path.join(artifactsRoot, input.artifact_class);
  const absolutePath = path.join(targetDir, ...name.split('/'));
  const indexPath = path.join(artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);

  assertSafeRepositoryPath(artifactsRoot, { allowMissingLeaf: true });
  assertSafeRepositoryPath(targetDir, { allowMissingLeaf: true });
  assertSafeRepositoryPath(absolutePath, { allowMissingLeaf: true });
  assertSafeRepositoryPath(indexPath, { allowMissingLeaf: true });

  // Fail closed: both the artifact and its index must be inside a recognized
  // scoped-artifact root, expressed repo-relative (never machine-absolute).
  const repoRelative = pathResolver.toRepoRelative(absolutePath).split(path.sep).join('/');
  const indexRepoRelative = pathResolver.toRepoRelative(indexPath).split(path.sep).join('/');
  if (!isScopedArtifactPath(repoRelative) || !isScopedArtifactPath(indexRepoRelative)) {
    throw new Error(
      `writeScopedArtifact: resolved path is outside the governed scoped-artifact roots: ${repoRelative}`
    );
  }

  if (
    input.publish &&
    !input.scope.project &&
    !input.scope.mission &&
    !input.scope.organization &&
    !input.publish.task_session_id
  ) {
    throw new Error(
      'writeScopedArtifact: publish requires an owning project, mission, organization, or publish.task_session_id'
    );
  }

  const data = serializeScopedContent(input.content, input.format);
  const entry: ScopedArtifactIndexEntry = {
    name,
    artifact_class: input.artifact_class,
    path: repoRelative,
    scope: { ...input.scope },
    scope_kind: kind,
    written_at: nowIso(),
  };
  const catalog = scopedArtifactIndexCatalog(indexPath);
  const validatedEntry = catalog.validate(entry, indexPath);

  let artifactId: string | undefined;
  const performWrite = (): void => {
    if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
    ensureRegularScopedArtifactIndex(indexPath);
    safeWriteFile(absolutePath, data);
    appendJsonLine(indexPath, validatedEntry);
    if (input.publish) {
      artifactId = publishScopedArtifact(input, repoRelative, kind, tier);
    }
  };
  if (input.role) withRole(input.role, performWrite);
  else performWrite();

  return {
    absolute_path: absolutePath,
    repo_relative_path: repoRelative,
    index_path: indexPath,
    scope_kind: kind,
    ...(artifactId ? { artifact_id: artifactId } : {}),
  };
}

/**
 * Register a written scoped artifact as an ArtifactRecord. Tenant, project and
 * mission refs are carried so the surface viewer scope (tenant + tier) can be
 * resolved server-side; the tier travels in metadata for scopes whose tier is
 * not implied by a mission state.
 */
function publishScopedArtifact(
  input: WriteScopedArtifactInput,
  repoRelativePath: string,
  kind: ScopedArtifactScopeKind,
  tier: 'personal' | 'confidential' | 'public'
): string {
  const publication = input.publish as ScopedArtifactPublication;
  const record = createArtifactRecord({
    ...(publication.artifact_id ? { artifact_id: publication.artifact_id } : {}),
    kind: publication.kind,
    storage_class: 'artifact_store',
    path: repoRelativePath,
    ...(input.scope.tenant ? { tenant_slug: input.scope.tenant.trim().toLowerCase() } : {}),
    ...((input.scope.organization ?? publication.organization_id)
      ? { organization_id: input.scope.organization ?? publication.organization_id }
      : {}),
    ...(input.scope.project ? { project_id: input.scope.project } : {}),
    ...(input.scope.mission ? { mission_id: input.scope.mission } : {}),
    ...(publication.task_session_id ? { task_session_id: publication.task_session_id } : {}),
    ...(publication.preview_text ? { preview_text: publication.preview_text } : {}),
    metadata: {
      ...(publication.metadata || {}),
      tier,
      artifact_class: input.artifact_class,
      scope_kind: kind,
    },
  });
  saveArtifactRecord(publication.artifact_id ? mergeIntoExistingRecord(record) : record);
  return record.artifact_id;
}

/**
 * A caller-chosen record id may only update a record of the same owner:
 * tenant, organization, project, mission, task session and tier must match,
 * otherwise one scope could overwrite another's published record. Fields added
 * to the existing record since (delivery, review) are kept.
 */
function mergeIntoExistingRecord(record: ArtifactRecord): ArtifactRecord {
  const existing = loadArtifactRecord(record.artifact_id);
  if (!existing) return record;
  const owner = (value: ArtifactRecord) => ({
    tenant_slug: value.tenant_slug,
    organization_id: value.organization_id,
    project_id: value.project_id,
    mission_id: value.mission_id,
    task_session_id: value.task_session_id,
    tier: (value.metadata as { tier?: unknown } | undefined)?.tier,
  });
  if (JSON.stringify(owner(existing)) !== JSON.stringify(owner(record))) {
    throw new Error(
      `writeScopedArtifact: artifact_id ${record.artifact_id} belongs to another owner scope`
    );
  }
  return {
    ...existing,
    ...record,
    metadata: { ...(existing.metadata || {}), ...(record.metadata || {}) },
  };
}

/** Read a scope-local artifacts index. Returns [] when the scope has no index yet. */
export function readScopedArtifactIndex(
  scope: ScopedArtifactScope,
  tier?: 'personal' | 'confidential' | 'public'
): ScopedArtifactIndexEntry[] {
  const { artifactsRoot } = resolveScopeArtifactsRoot(
    scope,
    tier ?? (scope.system ? 'public' : 'confidential')
  );
  const indexPath = path.join(artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);
  const safeIndexPath = assertSafeRepositoryPath(indexPath, { allowMissingLeaf: true });
  ensureRegularScopedArtifactIndex(safeIndexPath);
  const catalog = scopedArtifactIndexCatalog(safeIndexPath);
  return readJsonLines<ScopedArtifactIndexEntry>(safeIndexPath, {
    map: (value, lineNumber) =>
      parseScopedArtifactIndexEntry(catalog.validate(value, `${safeIndexPath}:${lineNumber}`)),
  });
}
