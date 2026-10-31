import {
  resolveGovernedArtifactPath,
  ensureRegularGovernedArtifactFile,
} from './artifact-store-reader.js';
export {
  isGovernedArtifactPath,
  resolveGovernedArtifactPath,
  readGovernedArtifactJson,
} from './artifact-store-reader.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { isRecord, sanitizeIdSegment, readTextFile } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { createHash } from 'node:crypto';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
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
  safeReadFile,
  safeWriteFile,
} from '../secure-io.js';
import { countPptxSlides } from '../media/pptx-slide-count.js';
import {
  STORAGE_FLOOR_ROOTS,
  SYSTEM_PARTITION,
  classifyStorageFloorPath,
  storagePartitionSegments,
} from '../storage-layout.js';
import {
  OwnerScopeError,
  resolveOwnerScope,
  SHARED_TENANT,
  type OwnerRef,
} from '../owner-scope.js';
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
  /** Registered tenant; `shared` is an untenanted partition sentinel only with personal tier. */
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
  /** Atomically refuse an existing target, including a concurrent creator. */
  create_only?: boolean;
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

function sanitizeScopeSegment(value: string, label: string): string {
  const cleaned = sanitizeIdSegment(value);
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
      const cleaned = sanitizeIdSegment(seg);
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

interface ResolvedScopeRoot {
  artifactsRoot: string;
  kind: ScopedArtifactScopeKind;
  tier: 'personal' | 'confidential' | 'public';
  /** Owner tenant slug; undefined for untenanted (`shared`) and system scopes. */
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}

function ownedRoot(
  owner: OwnerRef,
  kind: ScopedArtifactScopeKind,
  scope: ScopedArtifactScope,
  requestedTier: 'personal' | 'confidential' | 'public' | undefined
): ResolvedScopeRoot {
  // The owner's record decides placement; the caller's tier/tenant only narrow.
  const resolved = resolveOwnerScope(owner, {
    ...(requestedTier ? { tier: requestedTier } : {}),
    ...(scope.tenant !== undefined ? { tenant: scope.tenant } : {}),
  });
  // The owner's organization / project are the record's too: a caller value
  // that names another one is a contradiction, like a tier or tenant.
  const contradictions: string[] = [];
  if (
    scope.organization !== undefined &&
    resolved.organization_id &&
    scope.organization !== resolved.organization_id
  ) {
    contradictions.push(`organization '${resolved.organization_id}'`);
  }
  if (
    owner.kind === 'mission' &&
    scope.project !== undefined &&
    resolved.project_id &&
    scope.project !== resolved.project_id
  ) {
    contradictions.push(`project '${resolved.project_id}'`);
  }
  if (contradictions.length > 0) {
    throw new OwnerScopeError({
      code: 'SCOPE_CONTRADICTS_OWNER',
      owner,
      what: `${owner.kind} ${owner.id} belongs to ${contradictions.join(' and ')}`,
      why: "an owned write is attributed by the owner's own record",
      remedy: "drop the explicit organization/project or pass the owner's own",
    });
  }
  return {
    artifactsRoot: path.join(resolved.dir, 'artifacts'),
    kind,
    tier: resolved.tier,
    ...(resolved.tenant !== SHARED_TENANT ? { tenant: resolved.tenant } : {}),
    ...(resolved.organization_id ? { organizationId: resolved.organization_id } : {}),
    ...(resolved.project_id ? { projectId: resolved.project_id } : {}),
  };
}

/**
 * Resolve the `artifacts` root of a scope. Mission/project/organization scopes
 * own an `artifacts/` subtree of their owner's directory, placed by the owner's
 * own record (resolveOwnerScope) — an explicit tier/tenant must agree with it.
 * Session scopes own a runtime-session subtree; tenant and system scopes own a
 * partition of the storage-layout artifact floor
 * (`active/shared/artifacts/<tier>/<tenant>/` and `active/shared/artifacts/system/`).
 */
function resolveScopeArtifactsRoot(
  scope: ScopedArtifactScope,
  requestedTier?: 'personal' | 'confidential' | 'public'
): ResolvedScopeRoot {
  if (scope.system !== undefined) {
    const others = (
      ['tenant', 'organization', 'project', 'mission', 'task', 'session'] as const
    ).filter((key) => scope[key] !== undefined);
    if (scope.system !== true || others.length > 0) {
      throw new Error(
        'writeScopedArtifact: system scope is platform-wide and cannot be combined with tenant/organization/project/mission/task/session'
      );
    }
    if (requestedTier && requestedTier !== 'public') {
      throw new Error('writeScopedArtifact: system scope carries public-tier data only');
    }
    return {
      artifactsRoot: artifactFloorRoot(storagePartitionSegments(SYSTEM_PARTITION)),
      kind: 'system',
      tier: 'public',
    };
  }
  if (scope.task !== undefined) {
    if (!scope.mission) {
      throw new Error('writeScopedArtifact: task scope requires a mission reference');
    }
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    return ownedRoot({ kind: 'mission', id: mission }, 'task', scope, requestedTier);
  }
  if (scope.mission !== undefined) {
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    return ownedRoot({ kind: 'mission', id: mission }, 'mission', scope, requestedTier);
  }
  if (scope.project !== undefined) {
    const project = sanitizeScopeSegment(scope.project, 'project');
    return ownedRoot({ kind: 'project', id: project }, 'project', scope, requestedTier);
  }
  const tier = requestedTier ?? 'confidential';
  const tenant = scope.tenant?.trim().toLowerCase() || undefined;
  if (scope.session !== undefined) {
    const session = sanitizeScopeSegment(scope.session, 'session');
    return {
      artifactsRoot: path.join(pathResolver.volatile('session', session), 'artifacts'),
      kind: 'session',
      tier,
      ...(tenant ? { tenant } : {}),
    };
  }
  if (scope.organization !== undefined) {
    const organization = sanitizeScopeSegment(scope.organization, 'organization');
    return ownedRoot(
      { kind: 'organization', id: organization },
      'organization',
      scope,
      requestedTier
    );
  }
  if (scope.tenant !== undefined) {
    let segments: string[];
    try {
      // Personal operator evidence has no tenant. Preserve the existing shared
      // owner sentinel without treating it as a registered/confidential tenant.
      segments = storagePartitionSegments({
        kind: 'tier',
        tier,
        ...(tier === 'personal' && scope.tenant === SHARED_TENANT ? {} : { tenant: scope.tenant }),
      });
    } catch {
      throw new Error(
        `writeScopedArtifact: invalid tenant reference: ${JSON.stringify(scope.tenant)}`
      );
    }
    return {
      artifactsRoot: artifactFloorRoot(segments),
      kind: 'tenant',
      tier,
      ...(tenant && tenant !== SHARED_TENANT ? { tenant } : {}),
    };
  }
  throw new Error(
    'writeScopedArtifact: scope must name at least one of system/tenant/organization/project/mission/task/session'
  );
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
/**
 * Directory a scoped artifact of `artifactClass` lands in, without writing
 * anything. Long-lived capture surfaces (a meeting notepad, a recorder) hold a
 * directory open and append to it over a session, so they cannot express their
 * placement as a single `writeScopedArtifact` call. Giving them the same
 * resolved directory keeps their output inside the scope that owns it instead
 * of on the shared tmp floor, where a 24h TTL deletes it outright.
 */
export function scopedArtifactDir(
  scope: ScopedArtifactScope,
  artifactClass: RetentionArtifactClass,
  tier: 'personal' | 'confidential' | 'public' = 'confidential'
): { dir: string; scope_kind: ScopedArtifactScopeKind } {
  const { artifactsRoot, kind } = resolveScopeArtifactsRoot(scope, tier);
  const dir =
    kind === 'task'
      ? path.join(artifactsRoot, artifactClass, scopedTaskArtifactDirName(scope.task as string))
      : path.join(artifactsRoot, artifactClass);
  assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  return { dir, scope_kind: kind };
}

export function writeScopedArtifact(input: WriteScopedArtifactInput): WriteScopedArtifactResult {
  return writeScopedArtifactInternal(input);
}

function writeScopedArtifactInternal(
  input: WriteScopedArtifactInput,
  writtenAt = nowIso()
): WriteScopedArtifactResult {
  if (!RETENTION_ARTIFACT_CLASSES.includes(input.artifact_class)) {
    throw new Error(
      `writeScopedArtifact: invalid artifact_class ${JSON.stringify(input.artifact_class)} ` +
        `(expected one of ${RETENTION_ARTIFACT_CLASSES.join('/')})`
    );
  }
  const root = resolveScopeArtifactsRoot(input.scope, input.tier);
  const { artifactsRoot, kind } = root;
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
    written_at: writtenAt,
  };
  const catalog = scopedArtifactIndexCatalog(indexPath);
  const validatedEntry = catalog.validate(entry, indexPath);

  let artifactId: string | undefined;
  const performWrite = (): void => {
    if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
    ensureRegularScopedArtifactIndex(indexPath);
    safeWriteFile(absolutePath, data, input.create_only ? { createOnly: true } : undefined);
    appendJsonLine(indexPath, validatedEntry);
    if (input.publish) {
      artifactId = publishScopedArtifact(input, repoRelative, root);
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

const MAX_SCOPED_ARTIFACT_ATTEMPTS = 128;
const MAX_ATTEMPT_CONTENT_BYTES = 1024 * 1024;
const ATTEMPT_FILE = /^attempt-(\d{6})\.json$/u;
const ATTEMPT_SCOPE_KEYS = [
  'system',
  'tenant',
  'organization',
  'project',
  'mission',
  'task',
  'session',
] as const;

export interface ScopedArtifactAttemptAddress {
  scope: ScopedArtifactScope;
  tier?: 'personal' | 'confidential' | 'public';
  artifact_class: RetentionArtifactClass;
  /** One server-owned safe segment, never a model-supplied path. */
  namespace: string;
  parent_key: string;
  effect_key: string;
}
export interface ScopedArtifactAttemptMetadata extends ScopedArtifactAttemptAddress {
  tier: 'personal' | 'confidential' | 'public';
  schema_version: 1;
  attempt: number;
  created_at: string;
  expires_at: string;
}
export interface ScopedArtifactAttemptEnvelope<T> extends ScopedArtifactAttemptMetadata {
  content_hash: string;
  content: T;
}
export interface ScopedArtifactAttemptResult<T> {
  attempt: number;
  envelope: ScopedArtifactAttemptEnvelope<T>;
  artifact: WriteScopedArtifactResult;
  adopted_existing: boolean;
}
export interface ReadScopedArtifactAttemptInput<T> extends ScopedArtifactAttemptAddress {
  /** Omit to read the highest allocated ordinal; reading never repairs an orphan. */
  attempt?: number;
  /** Check historical integrity, including metadata, without rejecting only because it expired. */
  validateContent(content: unknown, metadata: ScopedArtifactAttemptMetadata): T;
}
export interface WriteScopedArtifactAttemptInput<T> extends Omit<
  ReadScopedArtifactAttemptInput<T>,
  'attempt'
> {
  content: T;
  created_at: string;
  expires_at: string;
  now(): number;
}

/** JSON.stringify must not invoke code or discard properties before integrity hashing. */
function assertAttemptJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error('artifact attempt JSON nesting exceeds its bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value))
    throw new Error('artifact attempt requires finite acyclic JSON');
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
    throw new Error('artifact attempt requires plain JSON');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100_000 || (array && value.length > 100_000))
    throw new Error('artifact attempt JSON collection exceeds its bound');
  ancestors.add(value);
  for (const key of keys) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('artifact attempt has a dangerous JSON key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error('artifact attempt requires JSON data properties');
    if (array && key === 'length') continue;
    const index = Number(key);
    if (
      !descriptor.enumerable ||
      (array &&
        (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key))
    )
      throw new Error('artifact attempt contains a lossy JSON property');
    assertAttemptJson(descriptor.value, ancestors, depth + 1);
  }
  if (array && keys.length !== value.length + 1)
    throw new Error('artifact attempt requires dense JSON arrays');
  ancestors.delete(value);
}
function attemptContentBytes(value: unknown): string {
  assertAttemptJson(value);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_ATTEMPT_CONTENT_BYTES)
    throw new Error('artifact attempt content exceeds its byte bound');
  return bytes;
}
const attemptHash = (bytes: string): string =>
  createHash('sha256').update(bytes, 'utf8').digest('hex');
function attemptTime(value: unknown): number {
  if (typeof value !== 'string') throw new Error('invalid artifact attempt timestamp');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    throw new Error('artifact attempt requires canonical ISO timestamps');
  return time;
}

function attemptContext(input: ScopedArtifactAttemptAddress) {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/u.test(input.namespace) ||
    !/^[a-f0-9]{64}$/u.test(input.parent_key) ||
    !/^[a-f0-9]{64}$/u.test(input.effect_key)
  )
    throw new Error('invalid artifact attempt address');
  if (!RETENTION_ARTIFACT_CLASSES.includes(input.artifact_class))
    throw new Error('invalid artifact attempt class');
  assertAttemptJson(input.scope);
  if (
    Object.keys(input.scope).some((key) => !(ATTEMPT_SCOPE_KEYS as readonly string[]).includes(key))
  )
    throw new Error('invalid artifact attempt scope');
  const scope = Object.fromEntries(
    ATTEMPT_SCOPE_KEYS.filter((key) => input.scope[key] !== undefined).map((key) => [
      key,
      input.scope[key],
    ])
  ) as ScopedArtifactScope;
  const root = resolveScopeArtifactsRoot(scope, input.tier);
  const base = kindArtifactDir(root.artifactsRoot, root.kind, scope, input.artifact_class);
  const dir = path.join(base, input.namespace, input.parent_key);
  const indexPath = path.join(root.artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);
  // The boundary walks every ancestor, rejecting links and ENOTDIR. Metadata
  // authorization applies only to the owned leaf, never tenantless tier parents.
  assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  try {
    if (!safeLstat(dir).isDirectory())
      throw new Error('artifact attempt directory must be regular');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  ensureRegularScopedArtifactIndex(indexPath);
  return { root, scope, dir, indexPath, prefix: `${input.namespace}/${input.parent_key}/` };
}
function kindArtifactDir(
  root: string,
  kind: ScopedArtifactScopeKind,
  scope: ScopedArtifactScope,
  artifactClass: RetentionArtifactClass
): string {
  return kind === 'task'
    ? path.join(root, artifactClass, scopedTaskArtifactDirName(scope.task as string))
    : path.join(root, artifactClass);
}
type AttemptContext = ReturnType<typeof attemptContext>;
function attemptArtifact(context: AttemptContext, ordinal: number): WriteScopedArtifactResult {
  const absolute = assertSafeRepositoryPath(
    path.join(context.dir, `attempt-${String(ordinal).padStart(6, '0')}.json`),
    { allowMissingLeaf: true }
  );
  const relative = pathResolver.toRepoRelative(absolute).split(path.sep).join('/');
  if (!isScopedArtifactPath(relative)) throw new Error('artifact attempt escaped its scoped root');
  return {
    absolute_path: absolute,
    repo_relative_path: relative,
    index_path: context.indexPath,
    scope_kind: context.root.kind,
  };
}
function ordinalFromName(name: string): number {
  const match = ATTEMPT_FILE.exec(name);
  const ordinal = match ? Number(match[1]) : 0;
  if (ordinal < 1 || ordinal > MAX_SCOPED_ARTIFACT_ATTEMPTS)
    throw new Error('invalid artifact attempt ordinal');
  return ordinal;
}
function attemptIndexEntry(
  context: AttemptContext,
  envelope: ScopedArtifactAttemptMetadata
): ScopedArtifactIndexEntry {
  return scopedArtifactIndexCatalog(context.indexPath).validate(
    {
      name: context.prefix + `attempt-${String(envelope.attempt).padStart(6, '0')}.json`,
      artifact_class: envelope.artifact_class,
      path: attemptArtifact(context, envelope.attempt).repo_relative_path,
      scope: context.scope,
      scope_kind: context.root.kind,
      written_at: envelope.created_at,
    },
    context.indexPath
  );
}
function checkedAttemptContent<T>(
  content: unknown,
  metadata: ScopedArtifactAttemptMetadata,
  validate: ReadScopedArtifactAttemptInput<T>['validateContent']
): T {
  const bytes = attemptContentBytes(content);
  const detached = parseSafeJsonInput(bytes, 'artifact attempt content');
  const result = validate(detached, structuredClone(metadata));
  if (attemptContentBytes(detached) !== bytes || attemptContentBytes(result) !== bytes)
    throw new Error('artifact attempt validator mutated or transformed content');
  return parseSafeJsonInput(bytes, 'artifact attempt content') as T;
}
function loadAttempt<T>(
  input: ReadScopedArtifactAttemptInput<T>,
  context: AttemptContext,
  ordinal: number
): ScopedArtifactAttemptEnvelope<T> {
  const artifact = attemptArtifact(context, ordinal);
  if (!safeLstat(artifact.absolute_path).isFile())
    throw new Error('artifact attempt must be a regular file');
  const raw = readTextFile(artifact.absolute_path);
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTEMPT_CONTENT_BYTES + 16_384)
    throw new Error('artifact attempt envelope exceeds its byte bound');
  const value = parseSafeJsonInput(raw, 'artifact attempt envelope');
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      [
        'schema_version',
        'scope',
        'tier',
        'artifact_class',
        'namespace',
        'parent_key',
        'effect_key',
        'attempt',
        'created_at',
        'expires_at',
        'content_hash',
        'content',
      ]
        .sort()
        .join(',')
  )
    throw new Error('invalid artifact attempt envelope');
  const metadata: ScopedArtifactAttemptMetadata = {
    schema_version: 1,
    scope: context.scope,
    tier: context.root.tier,
    artifact_class: input.artifact_class,
    namespace: input.namespace,
    parent_key: input.parent_key,
    effect_key: input.effect_key,
    attempt: ordinal,
    created_at: value.created_at as string,
    expires_at: value.expires_at as string,
  };
  for (const [key, expected] of Object.entries(metadata)) {
    if (key === 'scope') {
      const savedScope = value.scope;
      assertAttemptJson(savedScope);
      if (
        !isRecord(savedScope) ||
        Object.keys(savedScope).length !== Object.keys(context.scope).length ||
        Object.entries(context.scope).some(([field, entry]) => savedScope[field] !== entry)
      )
        throw new Error('artifact attempt scope mismatch');
    } else if (value[key] !== expected) throw new Error('artifact attempt identity mismatch');
  }
  if (attemptTime(metadata.expires_at) <= attemptTime(metadata.created_at))
    throw new Error('invalid artifact attempt lifetime');
  if (value.content_hash !== attemptHash(attemptContentBytes(value.content)))
    throw new Error('artifact attempt content hash mismatch');
  return {
    ...metadata,
    content_hash: value.content_hash as string,
    content: checkedAttemptContent(value.content, metadata, input.validateContent),
  };
}
function scanAttempts<T>(input: ReadScopedArtifactAttemptInput<T>, context: AttemptContext) {
  const index = readScopedArtifactIndex(context.scope, context.root.tier);
  let highWater = 0;
  const scopedPrefix = pathResolver.toRepoRelative(context.dir).split(path.sep).join('/') + '/';
  const matching = index.filter(
    (entry) =>
      (entry.artifact_class === input.artifact_class && entry.name.startsWith(context.prefix)) ||
      entry.path.startsWith(scopedPrefix)
  );
  for (const entry of matching) {
    const ordinal = ordinalFromName(entry.name.slice(context.prefix.length));
    const expected = attemptArtifact(context, ordinal);
    if (
      entry.artifact_class !== input.artifact_class ||
      entry.path !== expected.repo_relative_path ||
      entry.scope_kind !== context.root.kind ||
      Object.keys(entry.scope).length !== Object.keys(context.scope).length ||
      Object.entries(context.scope).some(
        ([key, value]) => (entry.scope as Record<string, unknown>)[key] !== value
      )
    )
      throw new Error('artifact attempt index scope or path mismatch');
    highWater = Math.max(highWater, ordinal);
  }
  const envelopes = new Map<number, ScopedArtifactAttemptEnvelope<T>>();
  if (safeExistsSync(context.dir)) {
    const files = safeReaddir(context.dir);
    if (files.length > MAX_SCOPED_ARTIFACT_ATTEMPTS * 3)
      throw new Error('artifact attempt directory exceeds its bound');
    for (const file of files) {
      // Secure atomic publication may leave temporary siblings; they are never attempt slots.
      if (/^attempt-\d{6}\.json\.tmp\.[a-z0-9]+\.[a-z0-9]*$/u.test(file)) continue;
      const ordinal = ordinalFromName(file);
      envelopes.set(ordinal, loadAttempt(input, context, ordinal));
      highWater = Math.max(highWater, ordinal);
    }
  }
  return { index, highWater, envelopes };
}
function ensureAttemptRegistration<T>(
  context: AttemptContext,
  envelope: ScopedArtifactAttemptEnvelope<T>,
  index: ScopedArtifactIndexEntry[],
  repair: boolean
): void {
  const expected = attemptIndexEntry(context, envelope);
  const samePath = index.filter((entry) => entry.path === expected.path);
  if (samePath.some((entry) => !sameAttemptIndexEntry(entry, expected)))
    throw new Error('artifact attempt has conflicting index registration');
  if (samePath.length) return;
  if (!repair) throw new Error('artifact attempt is not registered');
  appendJsonLine(context.indexPath, expected);
  const proof = readScopedArtifactIndex(context.scope, context.root.tier).filter(
    (entry) => entry.path === expected.path
  );
  if (!proof.length || proof.some((entry) => !sameAttemptIndexEntry(entry, expected)))
    throw new Error('artifact attempt registration could not be verified');
}

function sameAttemptIndexEntry(
  left: ScopedArtifactIndexEntry,
  right: ScopedArtifactIndexEntry
): boolean {
  return (
    left.name === right.name &&
    left.artifact_class === right.artifact_class &&
    left.path === right.path &&
    left.scope_kind === right.scope_kind &&
    left.written_at === right.written_at &&
    Object.keys(left.scope).length === Object.keys(right.scope).length &&
    ATTEMPT_SCOPE_KEYS.every((key) => left.scope[key] === right.scope[key])
  );
}

/** Read-only access by scoped identity and ordinal; no caller-provided path or role. */
export function readScopedArtifactAttempt<T>(
  input: ReadScopedArtifactAttemptInput<T>
): ScopedArtifactAttemptResult<T> | null {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'scope',
          'tier',
          'artifact_class',
          'namespace',
          'parent_key',
          'effect_key',
          'attempt',
          'validateContent',
        ].includes(key)
    )
  )
    throw new Error('unsupported artifact attempt read option');
  if (
    input.attempt !== undefined &&
    (!Number.isInteger(input.attempt) ||
      input.attempt < 1 ||
      input.attempt > MAX_SCOPED_ARTIFACT_ATTEMPTS)
  )
    throw new Error('invalid artifact attempt ordinal');
  const context = attemptContext(input);
  const scanned = scanAttempts(input, context);
  if (scanned.highWater > 0 && !scanned.envelopes.has(scanned.highWater))
    throw new Error(
      'artifact attempt latest indexed payload is missing; history recovery is required'
    );
  const ordinal = input.attempt ?? scanned.highWater;
  const envelope = scanned.envelopes.get(ordinal);
  if (!envelope) return null;
  ensureAttemptRegistration(context, envelope, scanned.index, false);
  return {
    attempt: ordinal,
    envelope,
    artifact: attemptArtifact(context, ordinal),
    adopted_existing: true,
  };
}

/**
 * Create-only version allocation using existing artifact files/index, without a second store or
 * lock. Concurrent creators converge at the atomic slot; valid winners are never overwritten.
 * Registration-only orphan repair may append byte-identical rows; readers treat them as one ref.
 */
export function writeScopedArtifactAttempt<T>(
  input: WriteScopedArtifactAttemptInput<T>
): ScopedArtifactAttemptResult<T> {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'scope',
          'tier',
          'artifact_class',
          'namespace',
          'parent_key',
          'effect_key',
          'content',
          'created_at',
          'expires_at',
          'now',
          'validateContent',
        ].includes(key)
    )
  )
    throw new Error('unsupported artifact attempt write option');
  const context = attemptContext(input);
  const now = (): number => {
    const time = input.now();
    if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()))
      throw new Error('invalid artifact attempt clock');
    return time;
  };
  for (let collision = 0; collision < MAX_SCOPED_ARTIFACT_ATTEMPTS; collision++) {
    const scanned = scanAttempts(input, context);
    if (scanned.highWater > 0 && !scanned.envelopes.has(scanned.highWater))
      throw new Error(
        'artifact attempt latest indexed payload is missing; history recovery is required'
      );
    for (const envelope of scanned.envelopes.values())
      ensureAttemptRegistration(context, envelope, scanned.index, true);
    const latest = scanned.envelopes.get(scanned.highWater);
    const sampledNow = now();
    if (latest && Date.parse(latest.created_at) > sampledNow)
      throw new Error('artifact attempt clock regressed before the current attempt');
    if (latest && sampledNow < Date.parse(latest.expires_at)) {
      return {
        attempt: latest.attempt,
        envelope: latest,
        artifact: attemptArtifact(context, latest.attempt),
        adopted_existing: true,
      };
    }
    if (scanned.highWater >= MAX_SCOPED_ARTIFACT_ATTEMPTS)
      throw new Error('artifact attempt ordinal budget exhausted');
    const ordinal = scanned.highWater + 1;
    const metadata: ScopedArtifactAttemptMetadata = {
      schema_version: 1,
      scope: context.scope,
      tier: context.root.tier,
      artifact_class: input.artifact_class,
      namespace: input.namespace,
      parent_key: input.parent_key,
      effect_key: input.effect_key,
      attempt: ordinal,
      created_at: input.created_at,
      expires_at: input.expires_at,
    };
    const created = attemptTime(input.created_at),
      expires = attemptTime(input.expires_at);
    const candidateNow = now();
    if (created > candidateNow || expires <= candidateNow || expires <= created)
      throw new Error('artifact attempt candidate is not currently valid');
    const content = checkedAttemptContent(input.content, metadata, input.validateContent);
    const envelope: ScopedArtifactAttemptEnvelope<T> = {
      ...metadata,
      content_hash: attemptHash(attemptContentBytes(content)),
      content,
    };
    const publicationNow = now();
    if (created > publicationNow)
      throw new Error('artifact attempt clock regressed before publication');
    if (publicationNow >= expires)
      throw new Error('artifact attempt candidate expired before publication');
    try {
      const artifact = writeScopedArtifactInternal(
        {
          scope: context.scope,
          tier: context.root.tier,
          artifact_class: input.artifact_class,
          name: context.prefix + `attempt-${String(ordinal).padStart(6, '0')}.json`,
          content: envelope,
          format: 'json',
          create_only: true,
        },
        metadata.created_at
      );
      if (artifact.repo_relative_path !== attemptArtifact(context, ordinal).repo_relative_path)
        throw new Error('artifact attempt owner changed during publication');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Re-read the occupied slot, including its integrity and fresh expiration, on the next pass.
      continue;
    }
    const readback = loadAttempt(input, context, ordinal);
    ensureAttemptRegistration(
      context,
      readback,
      readScopedArtifactIndex(context.scope, context.root.tier),
      false
    );
    const adoptionNow = now();
    if (Date.parse(readback.created_at) > adoptionNow)
      throw new Error('artifact attempt clock regressed before adoption');
    if (adoptionNow >= Date.parse(readback.expires_at))
      throw new Error('artifact attempt expired before adoption');
    return {
      attempt: ordinal,
      envelope: readback,
      artifact: attemptArtifact(context, ordinal),
      adopted_existing: false,
    };
  }
  throw new Error('artifact attempt collision budget exhausted');
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
  root: ResolvedScopeRoot
): string {
  const { kind, tier } = root;
  const publication = input.publish as ScopedArtifactPublication;
  if (
    publication.organization_id &&
    root.organizationId &&
    publication.organization_id !== root.organizationId
  ) {
    throw new Error(
      `[SCOPE_CONTRADICTS_OWNER] publish.organization_id '${publication.organization_id}' — the owner belongs to organization '${root.organizationId}' | next: drop publish.organization_id`
    );
  }
  // The owner's organization wins over any caller-supplied one.
  const organizationId =
    root.organizationId ?? input.scope.organization ?? publication.organization_id;
  const metadata = { ...(publication.metadata || {}) };
  // Deck records fail the quality gate without a slide count — stamp it from
  // the written pptx when the caller didn't provide one.
  if (
    /\.pptx$/i.test(repoRelativePath) &&
    metadata.slides_count === undefined &&
    metadata.slide_count === undefined &&
    metadata.total_slides === undefined &&
    !Array.isArray(metadata.slides)
  ) {
    try {
      const slides = countPptxSlides(
        safeReadFile(pathResolver.rootResolve(repoRelativePath), { encoding: null }) as Buffer
      );
      if (slides !== undefined) metadata.slides_count = slides;
    } catch {
      // A missing/unreadable artifact body must not block publication.
    }
  }
  const record = createArtifactRecord({
    ...(publication.artifact_id ? { artifact_id: publication.artifact_id } : {}),
    kind: publication.kind,
    storage_class: 'artifact_store',
    path: repoRelativePath,
    // The owner's tenant, not the caller's: surfaces scope viewers by it.
    ...(root.tenant ? { tenant_slug: root.tenant } : {}),
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(input.scope.project ? { project_id: input.scope.project } : {}),
    ...(input.scope.mission ? { mission_id: input.scope.mission } : {}),
    ...(publication.task_session_id ? { task_session_id: publication.task_session_id } : {}),
    ...(publication.preview_text ? { preview_text: publication.preview_text } : {}),
    metadata: {
      ...metadata,
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
  const { artifactsRoot } = resolveScopeArtifactsRoot(scope, tier);
  const indexPath = path.join(artifactsRoot, SCOPED_ARTIFACT_INDEX_FILENAME);
  const safeIndexPath = assertSafeRepositoryPath(indexPath, { allowMissingLeaf: true });
  ensureRegularScopedArtifactIndex(safeIndexPath);
  const catalog = scopedArtifactIndexCatalog(safeIndexPath);
  return readJsonLines<ScopedArtifactIndexEntry>(safeIndexPath, {
    map: (value, lineNumber) =>
      parseScopedArtifactIndexEntry(catalog.validate(value, `${safeIndexPath}:${lineNumber}`)),
  });
}
