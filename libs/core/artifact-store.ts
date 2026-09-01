import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import {
  RETENTION_ARTIFACT_CLASSES,
  type RetentionArtifactClass,
} from './storage-retention-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
  loadJson,
} from './secure-io.js';

export type GovernedArtifactRole =
  | 'slack_bridge'
  | 'chronos_gateway'
  | 'surface_runtime'
  | 'mission_controller'
  | 'infrastructure_sentinel'
  | 'sovereign_concierge';

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
    appendJsonLine(logicalPath, value);
    return resolved;
  });
}

export function readGovernedArtifactJson<T>(logicalPath: string): T | null {
  const resolved = resolveGovernedArtifactPath(logicalPath);
  if (!safeExistsSync(resolved)) return null;
  return loadJson<T>(resolved);
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
  tenant?: string;
  project?: string;
  mission?: string;
  /** Task scope nests under its mission — `mission` is required with `task`. */
  task?: string;
  session?: string;
}

export type ScopedArtifactScopeKind = 'task' | 'mission' | 'project' | 'session' | 'tenant';

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
  /** Data tier for project/tenant/mission placement. Defaults to 'confidential'. */
  tier?: 'personal' | 'confidential' | 'public';
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
}

export const SCOPED_ARTIFACT_INDEX_FILENAME = 'artifacts-index.jsonl';

function sanitizeScopeSegment(value: string, label: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
      const cleaned = seg
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
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
 * canonical mission, project/tenant, or runtime-session directory.
 */
export function isScopedArtifactPath(logicalPath: string): boolean {
  if (logicalPath.startsWith('active/missions/') && logicalPath.includes('/artifacts/'))
    return true;
  if (logicalPath.startsWith('active/projects/') && logicalPath.includes('/artifacts/'))
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
  const scopeKeys = ['tenant', 'project', 'mission', 'task', 'session'] as const;
  if (!scopeKeys.some((key) => scope[key] !== undefined)) {
    throw new Error('scoped artifact index scope is empty');
  }
  for (const key of scopeKeys) {
    if (scope[key] !== undefined) persistedString(scope, key);
  }
  const scopeKind = persistedString(value, 'scope_kind');
  if (!['task', 'mission', 'project', 'session', 'tenant'].includes(scopeKind)) {
    throw new Error('scoped artifact index scope_kind is invalid');
  }
  const writtenAt = persistedString(value, 'written_at');
  if (!Number.isFinite(Date.parse(writtenAt))) {
    throw new Error('scoped artifact index written_at is invalid');
  }
  return value as unknown as ScopedArtifactIndexEntry;
}

function resolveScopeBase(
  scope: ScopedArtifactScope,
  tier: 'personal' | 'confidential' | 'public'
): { base: string; kind: ScopedArtifactScopeKind } {
  if (scope.task !== undefined) {
    if (!scope.mission) {
      throw new Error('writeScopedArtifact: task scope requires a mission reference');
    }
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    return {
      base: pathResolver.findMissionPath(mission) ?? pathResolver.missionDir(mission, tier),
      kind: 'task',
    };
  }
  if (scope.mission !== undefined) {
    const mission = sanitizeScopeSegment(scope.mission, 'mission');
    return {
      base: pathResolver.findMissionPath(mission) ?? pathResolver.missionDir(mission, tier),
      kind: 'mission',
    };
  }
  if (scope.project !== undefined) {
    const project = sanitizeScopeSegment(scope.project, 'project');
    const tenant = scope.tenant ? sanitizeScopeSegment(scope.tenant, 'tenant') : 'shared';
    return { base: pathResolver.projectWorkspaceDir(project, tier, tenant), kind: 'project' };
  }
  if (scope.session !== undefined) {
    const session = sanitizeScopeSegment(scope.session, 'session');
    return { base: pathResolver.volatile('session', session), kind: 'session' };
  }
  if (scope.tenant !== undefined) {
    const tenant = sanitizeScopeSegment(scope.tenant, 'tenant');
    return { base: pathResolver.volatile('tenant', tenant, { tier }), kind: 'tenant' };
  }
  throw new Error(
    'writeScopedArtifact: scope must name at least one of tenant/project/mission/task/session'
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
 * - tenant:  `active/projects/<tier>/<tenant>/artifacts/<class>/<name>`
 *
 * Precedence when several refs are present: task > mission > project > session > tenant.
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
  const tier = input.tier ?? 'confidential';
  const { base, kind } = resolveScopeBase(input.scope, tier);
  const name = sanitizeArtifactName(input.name);
  const artifactsRoot = path.join(base, 'artifacts');
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

  assertSafeRepositoryPath(base, { allowMissingLeaf: true });
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

  const data = serializeScopedContent(input.content, input.format);
  const entry: ScopedArtifactIndexEntry = {
    name,
    artifact_class: input.artifact_class,
    path: repoRelative,
    scope: { ...input.scope },
    scope_kind: kind,
    written_at: new Date().toISOString(),
  };

  const performWrite = (): void => {
    if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
    safeWriteFile(absolutePath, data);
    appendJsonLine(indexPath, entry);
  };
  if (input.role) withRole(input.role, performWrite);
  else performWrite();

  return {
    absolute_path: absolutePath,
    repo_relative_path: repoRelative,
    index_path: indexPath,
    scope_kind: kind,
  };
}

/** Read a scope-local artifacts index. Returns [] when the scope has no index yet. */
export function readScopedArtifactIndex(
  scope: ScopedArtifactScope,
  tier?: 'personal' | 'confidential' | 'public'
): ScopedArtifactIndexEntry[] {
  const { base } = resolveScopeBase(scope, tier ?? 'confidential');
  const indexPath = path.join(base, 'artifacts', SCOPED_ARTIFACT_INDEX_FILENAME);
  return readJsonLines<ScopedArtifactIndexEntry>(
    assertSafeRepositoryPath(indexPath, { allowMissingLeaf: true }),
    { map: (value) => parseScopedArtifactIndexEntry(value) }
  );
}
