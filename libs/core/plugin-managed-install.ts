/**
 * KD-06: managed-copy plugin installation.
 *
 * Install flow is strictly: stage to a temp dir -> validate (containment +
 * manifest diagnostics, no code execution) -> atomic rename into the managed
 * directory. Runtime code must only ever reference the managed copy;
 * `listManagedPlugins` never `require()`s or otherwise executes plugin code —
 * a broken manifest degrades to a diagnostic listing entry instead of
 * throwing, but stays permanently non-activatable.
 *
 * Trust is derived exclusively via `plugin-source-trust.ts` from the
 * resolved source location. Anything other than `official` requires a
 * cancel-defaulted human approval (via approval-store) before it may be
 * activated — installing (staging + listing) never itself requires
 * approval, only activation does.
 *
 * EP-01/EP-02: the approval is bound to the managed copy's content digest,
 * the manifest version and the narrowed permission grant. Every activation
 * check recomputes the digest and re-derives the grant; any drift yields
 * `blocked_digest_mismatch`. Records written before digests existed are
 * treated as `pending_approval` until re-installed and re-approved.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { parseSafeJsonObjectValue, readJson } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { isRecord } from './foundation/text.js';
import {
  createApprovalRequest,
  computeApprovalPayloadHash,
  listApprovalRequests,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from './approval-store.js';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import {
  findDisallowedOfficialOnlySeam,
  isLegacyCoworkPermissionsBlock,
  loadPluginPermissionPolicy,
  narrowPluginPermissions,
  parsePluginPermissionGrant,
  parsePluginPermissionRequest,
  permissionsDigest,
  PLUGIN_RESERVED_SEAMS,
  summarizePermissionDiff,
  type NarrowPluginPermissionsResult,
  type PluginPermissionGrant,
  type PluginPermissionRequest,
} from './plugin-permissions.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { setManagedPluginGrantLookup } from './plugin-grant-runtime.js';
import { PLUGIN_MANIFEST_CANDIDATES } from './plugin-manifest-candidates.js';

// Re-exported so install surfaces can render/handle narrowing through this
// module's existing package export.
export {
  formatPermissionDiffTable,
  PluginPermissionNarrowedError,
  type PermissionDiffEntry,
  type PluginPermissionGrant,
} from './plugin-permissions.js';
import {
  assertPluginAssetsContained,
  derivePluginTrustLabel,
  resolvePluginSourceRealPath,
  isPathContainedIn,
  type DerivePluginTrustOptions,
  type PluginTrustLabel,
} from './plugin-source-trust.js';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeStat,
  safeWriteFile,
} from './secure-io.js';

export interface PluginManifestDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PluginManifestInfo {
  pluginId: string;
  displayName?: string;
  version?: string;
  raw: Record<string, unknown>;
}

export type PluginActivationStatus =
  'activatable' | 'pending_approval' | 'blocked_broken_manifest' | 'blocked_digest_mismatch';

export interface ManagedPluginRecord {
  pluginId: string;
  trust: PluginTrustLabel;
  trustReason: string;
  resolvedSourcePath: string;
  managedPath: string;
  manifest: PluginManifestInfo | null;
  diagnostics: PluginManifestDiagnostic[];
  activationStatus: PluginActivationStatus;
  approvalChannel?: string;
  approvalRequestId?: string;
  installedAt: string;
  /** EP-01: sha256 over the managed copy (absent only on legacy records). */
  contentDigest?: string;
  manifestVersion?: string | null;
  /** EP-02: grant narrowed at install time; bound into the approval hash. */
  grantedPermissions?: PluginPermissionGrant;
  permissionsDigest?: string;
  /** Tenant whose confidential scope the grant was narrowed against. */
  tenantSlug?: string;
}

export interface PluginPermissionPreview extends NarrowPluginPermissionsResult {
  pluginId: string;
  trust: PluginTrustLabel;
  request: PluginPermissionRequest;
}

export interface InstallPluginManagedParams {
  /** Caller-declared identifier for the managed slot (sanitized to a safe directory name). */
  pluginId: string;
  /** Absolute (or repo-relative) filesystem path to the already-fetched plugin content. */
  sourcePath: string;
  managedRoot?: string;
  curatedOriginPrefixes?: DerivePluginTrustOptions['curatedOriginPrefixes'];
  requestedBy?: string;
  approvalChannel?: string;
  missionId?: string;
  /** Tenant used to scope confidential fs grants (other tenants are always denied). */
  tenantSlug?: string;
  /**
   * Called with the requested/ceiling/granted diff after narrowing and
   * before any approval request is created. Never called when narrowing
   * throws `PluginPermissionNarrowedError` (nothing is installed then).
   */
  onPermissionsResolved?: (preview: PluginPermissionPreview) => void;
}

const MANAGED_RECORD_FILENAME = '.kyberion-managed-plugin.json';
const MANAGED_RECORD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/managed-plugin-record.schema.json'
);
// Shared precedence (plugin-manifest-candidates.ts); a package may contain only one.
const MANIFEST_CANDIDATE_RELATIVE_PATHS = PLUGIN_MANIFEST_CANDIDATES;
const DEFAULT_APPROVAL_CHANNEL = 'plugin-install';
const SHA256_HEX = /^[a-f0-9]{64}$/;

function defaultManagedRoot(): string {
  return pathResolver.shared('plugins/managed');
}

function normalizePluginId(pluginId: string): string {
  const trimmed = String(pluginId || '').trim();
  if (!trimmed || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(trimmed)) {
    throw new Error(`[POLICY_VIOLATION] Invalid plugin id: ${pluginId}`);
  }
  return trimmed;
}

/** Codepoint order — never localeCompare (cross-platform determinism, dev practices §2). */
function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MAX_MANIFEST_WALK_ENTRIES = 20_000;
const MAX_MANIFEST_WALK_DEPTH = 32;
const MANIFEST_CANDIDATES_LOWER = MANIFEST_CANDIDATE_RELATIVE_PATHS.map((candidate) =>
  candidate.toLowerCase()
);

class ManifestTreeTooLargeError extends Error {}

/**
 * Manifest candidates below the package root (e.g. `dist/plugin.json`). A
 * reader walking up from a nested entry would pick such a manifest instead of
 * the approved root one, so packages that ship any are refused. Names are
 * compared case-insensitively (case-insensitive filesystems resolve
 * `Plugin.json` too). Symlinks are not followed (the managed copy never
 * contains them). The walk is bounded; an oversized tree fails closed.
 */
function findNestedManifestCandidates(pluginRoot: string): string[] {
  const nested: string[] = [];
  let entries = 0;
  const walk = (dir: string, relDir: string, depth: number): void => {
    if (depth > MAX_MANIFEST_WALK_DEPTH) {
      throw new ManifestTreeTooLargeError(
        `directory nesting exceeds ${MAX_MANIFEST_WALK_DEPTH} levels at ${relDir}`
      );
    }
    for (const name of safeReaddir(dir).sort(codepointCompare)) {
      entries += 1;
      if (entries > MAX_MANIFEST_WALK_ENTRIES) {
        throw new ManifestTreeTooLargeError(
          `package tree exceeds ${MAX_MANIFEST_WALK_ENTRIES} entries`
        );
      }
      const relative = relDir ? `${relDir}/${name}` : name;
      const lower = relative.toLowerCase();
      if (
        !MANIFEST_CANDIDATES_LOWER.includes(lower) &&
        MANIFEST_CANDIDATES_LOWER.some((candidate) => lower.endsWith(`/${candidate}`))
      ) {
        nested.push(relative);
      }
      const absolute = path.join(dir, name);
      const stat = safeLstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(absolute, relative, depth + 1);
    }
  };
  walk(pluginRoot, '', 0);
  return nested;
}

/**
 * Reads a plugin manifest via JSON.parse only. Never requires/imports the
 * manifest or any plugin code — this function must stay side-effect free.
 */
function readPluginManifestSafely(pluginRoot: string): {
  manifest: PluginManifestInfo | null;
  diagnostics: PluginManifestDiagnostic[];
} {
  const diagnostics: PluginManifestDiagnostic[] = [];
  let nested: string[];
  try {
    nested = findNestedManifestCandidates(pluginRoot);
  } catch (err: unknown) {
    if (err instanceof ManifestTreeTooLargeError) {
      diagnostics.push({
        code: 'manifest_tree_too_large',
        message: `Package tree is too large to scan for nested manifests (${err.message}); refusing it.`,
        severity: 'error',
      });
      return { manifest: null, diagnostics };
    }
    diagnostics.push({
      code: 'manifest_unreadable',
      message: `Package tree could not be scanned for manifests: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }
  if (nested.length > 0) {
    diagnostics.push({
      code: 'manifest_nested',
      message: `Package contains plugin manifest candidates below its root (${nested.join(', ')}); only the root manifest may exist so every reader resolves the approved one.`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }
  const present = MANIFEST_CANDIDATE_RELATIVE_PATHS.filter((rel) =>
    safeExistsSync(path.join(pluginRoot, rel))
  );
  if (present.length > 1) {
    diagnostics.push({
      code: 'manifest_ambiguous',
      message: `Package contains more than one plugin manifest (${present.join(', ')}); keep exactly one so every reader agrees on it.`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }
  const candidatePath = present.length === 1 ? path.join(pluginRoot, present[0]) : undefined;
  if (!candidatePath) {
    diagnostics.push({
      code: 'manifest_missing',
      message: `No plugin manifest found (expected one of: ${MANIFEST_CANDIDATE_RELATIVE_PATHS.join(', ')}).`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }

  let parsed: Record<string, unknown>;
  try {
    if (!safeLstat(candidatePath).isFile()) {
      throw new Error(`plugin manifest must be a regular file: ${candidatePath}`);
    }
    parsed = parseSafeJsonObjectValue(
      readJson<unknown>(candidatePath),
      `plugin manifest ${candidatePath}`
    );
  } catch (err: unknown) {
    const code = err instanceof SyntaxError ? 'manifest_invalid_json' : 'manifest_unreadable';
    diagnostics.push({
      code,
      message:
        code === 'manifest_invalid_json'
          ? `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
          : `Manifest could not be read: ${err instanceof Error ? err.message : String(err)}`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }

  const pluginIdField =
    typeof parsed.plugin_id === 'string' && parsed.plugin_id.trim()
      ? parsed.plugin_id.trim()
      : typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : '';
  if (
    (parsed.plugin_id !== undefined &&
      (typeof parsed.plugin_id !== 'string' || parsed.plugin_id.trim() === '')) ||
    (parsed.name !== undefined && (typeof parsed.name !== 'string' || parsed.name.trim() === '')) ||
    (parsed.display_name !== undefined && typeof parsed.display_name !== 'string') ||
    (parsed.version !== undefined && typeof parsed.version !== 'string')
  ) {
    diagnostics.push({
      code: 'manifest_invalid_field',
      message: 'Manifest identifier and display fields must be non-empty strings when present.',
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }
  if (!pluginIdField) {
    diagnostics.push({
      code: 'manifest_missing_field',
      message: "Manifest is missing a required identifier field ('plugin_id' or 'name').",
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }
  const provides = parsed.provides;
  const declaredSeams =
    provides &&
    typeof provides === 'object' &&
    Array.isArray((provides as { seams?: unknown }).seams)
      ? ((provides as { seams: unknown[] }).seams as unknown[])
      : [];
  const reservedSeam = declaredSeams
    .map((seam) => String(seam).trim())
    .find((seam) => PLUGIN_RESERVED_SEAMS.includes(seam));
  if (reservedSeam) {
    diagnostics.push({
      code: 'manifest_reserved_seam',
      message: `Manifest declares the reserved seam '${reservedSeam}', which plugins may never provide.`,
      severity: 'error',
    });
    return { manifest: null, diagnostics };
  }

  return {
    manifest: {
      pluginId: pluginIdField,
      displayName: typeof parsed.display_name === 'string' ? parsed.display_name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      raw: parsed,
    },
    diagnostics,
  };
}

/**
 * Recursively stages sourceRoot into destRoot. Same-root symlinks to regular
 * files are dereferenced into real file copies (the managed copy never
 * contains symlinks); anything that escapes the source root — including
 * symlinked directories, which are rejected outright rather than traversed —
 * throws `PluginTrustViolationError` (from plugin-source-trust.ts).
 */
function stagePluginDirectory(sourceRoot: string, destRoot: string): void {
  assertPluginAssetsContained(sourceRoot);
  const sourceRootReal = resolvePluginSourceRealPath(sourceRoot);

  const copyDir = (srcDir: string, destDir: string): void => {
    safeMkdir(destDir, { recursive: true });
    for (const name of safeReaddir(srcDir)) {
      const srcPath = path.join(srcDir, name);
      const destPath = path.join(destDir, name);
      const lst = safeLstat(srcPath);
      if (lst.isSymbolicLink()) {
        const finalTarget = resolvePluginSourceRealPath(srcPath);
        if (!isPathContainedIn(sourceRootReal, finalTarget)) {
          // Defense in depth: assertPluginAssetsContained above should have
          // already caught this, but never copy an escaping link.
          throw new Error(
            `[POLICY_VIOLATION] Refusing to stage symlink escaping plugin root: ${srcPath} -> ${finalTarget}`
          );
        }
        const targetStat = safeStat(finalTarget);
        if (targetStat.isDirectory()) {
          throw new Error(
            `[POLICY_VIOLATION] Symlinked directories are not supported in plugin sources: ${srcPath}`
          );
        }
        safeCopyFileSync(finalTarget, destPath);
        continue;
      }
      if (lst.isDirectory()) {
        copyDir(srcPath, destPath);
        continue;
      }
      safeCopyFileSync(srcPath, destPath);
    }
  };

  copyDir(sourceRoot, destRoot);
}

/**
 * EP-01: sha256 over `relative/path\0sha256(content)\n` entries of every
 * regular file in the managed copy, sorted by codepoint of the POSIX
 * relative path. The managed record file itself is excluded. Symlinks and
 * special files are rejected (the managed copy never contains them).
 */
export function computePluginContentDigest(managedPath: string): string {
  const root = path.resolve(managedPath);
  const entries: string[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const name of safeReaddir(dir)) {
      const absolute = path.join(dir, name);
      const relative = relDir ? `${relDir}/${name}` : name;
      if (relative === MANAGED_RECORD_FILENAME) continue;
      const stat = safeLstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`[POLICY_VIOLATION] Managed plugin copy contains a symlink: ${relative}`);
      }
      if (stat.isDirectory()) {
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `[POLICY_VIOLATION] Managed plugin copy contains a special file: ${relative}`
        );
      }
      const content = safeReadFile(absolute, { encoding: null }) as Buffer;
      entries.push(`${relative}\0${createHash('sha256').update(content).digest('hex')}\n`);
    }
  };
  walk(root, '');
  const hash = createHash('sha256');
  for (const entry of entries.sort(codepointCompare)) hash.update(entry, 'utf8');
  return hash.digest('hex');
}

/**
 * Reads the EP-02 request from a parsed manifest. A Cowork v1 descriptive
 * `permissions` block is not an EP-02 declaration and yields deny-by-default.
 * Throws `[PLUGIN_PERMISSIONS_INVALID]` for a malformed declaration.
 */
function manifestPermissionRequest(manifest: PluginManifestInfo): {
  request: PluginPermissionRequest;
  legacyBlockIgnored: boolean;
} {
  const declared = manifest.raw.permissions;
  if (isLegacyCoworkPermissionsBlock(declared)) {
    return { request: parsePluginPermissionRequest(undefined), legacyBlockIgnored: true };
  }
  return { request: parsePluginPermissionRequest(declared), legacyBlockIgnored: false };
}

interface PluginApprovalBinding {
  pluginId: string;
  trust: PluginTrustLabel;
  resolvedSourcePath: string;
  contentDigest: string;
  manifestVersion: string | null;
  permissionsDigest: string;
}

function pluginApprovalCorrelationId(binding: PluginApprovalBinding): string {
  return createHash('sha256')
    .update(
      [
        binding.pluginId,
        binding.resolvedSourcePath,
        binding.contentDigest,
        binding.manifestVersion ?? '',
        binding.permissionsDigest,
      ].join('::')
    )
    .digest('hex')
    .slice(0, 32);
}

function pluginApprovalPayloadHash(binding: PluginApprovalBinding): string {
  return computeApprovalPayloadHash({
    plugin_id: binding.pluginId,
    trust: binding.trust,
    resolved_source_path: binding.resolvedSourcePath,
    content_digest: binding.contentDigest,
    manifest_version: binding.manifestVersion,
    permissions_digest: binding.permissionsDigest,
  });
}

function pluginApprovalEffectBinding(pluginId: string): string {
  return `plugin-install:activate:${pluginId}`;
}

/**
 * Ensures a cancel-defaulted human approval request exists for activating a
 * non-official plugin. Never auto-approves: a fresh request is created in
 * `pending` status and stays blocking until a human decides it via
 * `decideApprovalRequest` (approval-gate.ts's `enforceApprovalGate` pattern).
 */
function ensurePluginApprovalRequest(params: {
  binding: PluginApprovalBinding;
  permissionSummary: string;
  requestedBy?: string;
  channel: string;
  missionId?: string;
}): ApprovalRequestRecord {
  const { pluginId, trust, resolvedSourcePath } = params.binding;
  const correlationId = pluginApprovalCorrelationId(params.binding);
  const payloadHash = pluginApprovalPayloadHash(params.binding);
  const effectBinding = pluginApprovalEffectBinding(pluginId);

  const existing = listApprovalRequests({ storageChannels: [params.channel] }).find(
    (request) =>
      request.correlationId === correlationId &&
      request.accountability?.payloadHash === payloadHash &&
      request.accountability?.effectBinding === effectBinding
  );
  if (existing) return existing;

  const requestedBy = params.requestedBy?.trim() || 'plugin-installer';
  return createApprovalRequest('mission_controller', {
    channel: params.channel,
    storageChannel: params.channel,
    threadTs: correlationId,
    correlationId,
    requestedBy,
    draft: {
      title: `Approve third-party plugin activation: ${pluginId}`,
      summary: `Plugin '${pluginId}' was sourced from outside this repository's plugins/ tree (trust=${trust}) and defaults to cancelled until a human approves activation. Permissions granted: ${params.permissionSummary}`,
      details: [
        `Resolved source path: ${resolvedSourcePath}`,
        `Content digest: ${params.binding.contentDigest}`,
        `Manifest version: ${params.binding.manifestVersion ?? '(none)'}`,
        `Permissions digest: ${params.binding.permissionsDigest}`,
      ].join('\n'),
      severity: 'medium',
    },
    kind: 'channel-approval',
    requestedByContext: {
      surface: 'system',
      actorId: requestedBy,
      actorRole: 'plugin-installer',
      missionId: params.missionId,
    },
    justification: {
      reason:
        'Plugin trust is derived from provenance, not manifest self-declaration or catalog metadata; non-official activation defaults to cancelled.',
      requestedEffects: [effectBinding],
    },
    risk: { level: 'medium', restartScope: 'none', requiresStrongAuth: false },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
  });
}

type PluginIntegrity = 'verified' | 'legacy' | 'mismatch';

function resolveActivationStatus(params: {
  diagnostics: PluginManifestDiagnostic[];
  trust: PluginTrustLabel;
  integrity: PluginIntegrity;
  approval?: ApprovalRequestRecord;
}): PluginActivationStatus {
  if (params.diagnostics.some((d) => d.severity === 'error')) return 'blocked_broken_manifest';
  if (params.integrity === 'mismatch') return 'blocked_digest_mismatch';
  // Official provenance needs no approval (its digest is recorded, not approved).
  if (params.trust === 'official') return 'activatable';
  // Legacy non-official records (no digest) must be re-installed and re-approved.
  if (params.integrity === 'legacy') return 'pending_approval';
  return params.approval?.status === 'approved' ? 'activatable' : 'pending_approval';
}

function writeManagedRecord(managedDir: string, record: ManagedPluginRecord): void {
  const recordPath = path.join(managedDir, MANAGED_RECORD_FILENAME);
  const validated = defineCatalog<ManagedPluginRecord>({
    id: 'managed-plugin-record',
    path: recordPath,
    schema: MANAGED_RECORD_SCHEMA_PATH,
  }).validate(record, recordPath);
  safeWriteFile(recordPath, JSON.stringify(validated, null, 2));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

function parsePersistedPluginManifest(value: unknown): PluginManifestInfo | null {
  if (value === null) return null;
  const record = parseSafeJsonObjectValue(value, 'managed plugin manifest');
  if (!isNonEmptyString(record.pluginId))
    throw new Error('managed plugin manifest pluginId invalid');
  if (record.displayName !== undefined && typeof record.displayName !== 'string') {
    throw new Error('managed plugin manifest displayName invalid');
  }
  if (record.version !== undefined && typeof record.version !== 'string') {
    throw new Error('managed plugin manifest version invalid');
  }
  const displayName = record.displayName;
  const version = record.version;
  const raw = parseSafeJsonObjectValue(record.raw, 'managed plugin manifest raw');
  return {
    pluginId: record.pluginId,
    ...(typeof displayName === 'string' ? { displayName } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    raw,
  };
}

function parsePersistedPluginDiagnostics(value: unknown): PluginManifestDiagnostic[] {
  if (!Array.isArray(value)) throw new Error('managed plugin diagnostics must be an array');
  return value.map((candidate, index) => {
    const diagnostic = parseSafeJsonObjectValue(candidate, `managed plugin diagnostics[${index}]`);
    if (
      !isNonEmptyString(diagnostic.code) ||
      !isNonEmptyString(diagnostic.message) ||
      (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning')
    ) {
      throw new Error(`managed plugin diagnostics[${index}] invalid`);
    }
    return {
      code: diagnostic.code,
      message: diagnostic.message,
      severity: diagnostic.severity,
    };
  });
}

function parseManagedPluginRecord(value: unknown, managedDir: string): ManagedPluginRecord {
  const record = parseSafeJsonObjectValue(value, 'managed plugin record');
  const expectedKeys = new Set([
    'pluginId',
    'trust',
    'trustReason',
    'resolvedSourcePath',
    'managedPath',
    'manifest',
    'diagnostics',
    'activationStatus',
    'approvalChannel',
    'approvalRequestId',
    'installedAt',
    'contentDigest',
    'manifestVersion',
    'grantedPermissions',
    'permissionsDigest',
    'tenantSlug',
  ]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key))) {
    throw new Error('managed plugin record contains unknown fields');
  }

  const pluginId = normalizePluginId(String(record.pluginId || ''));
  if (record.pluginId !== pluginId || !isNonEmptyString(record.trustReason)) {
    throw new Error('managed plugin record identity invalid');
  }
  if (record.trust !== 'official' && record.trust !== 'curated' && record.trust !== 'third-party') {
    throw new Error('managed plugin record trust invalid');
  }
  if (!isNonEmptyString(record.resolvedSourcePath)) {
    throw new Error('managed plugin record source invalid');
  }
  if (!isNonEmptyString(record.managedPath)) {
    throw new Error('managed plugin record managed path invalid');
  }
  const safeManagedDir = assertSafeRepositoryPath(managedDir, { allowMissingLeaf: true });
  const persistedManagedDir = assertSafeRepositoryPath(record.managedPath, {
    allowMissingLeaf: true,
  });
  if (path.resolve(safeManagedDir) !== path.resolve(persistedManagedDir)) {
    throw new Error('managed plugin record managed path mismatch');
  }

  const manifest = parsePersistedPluginManifest(record.manifest);
  const diagnostics = parsePersistedPluginDiagnostics(record.diagnostics);
  if (
    record.activationStatus !== 'activatable' &&
    record.activationStatus !== 'pending_approval' &&
    record.activationStatus !== 'blocked_broken_manifest' &&
    record.activationStatus !== 'blocked_digest_mismatch'
  ) {
    throw new Error('managed plugin record activation status invalid');
  }
  if (!isValidTimestamp(record.installedAt)) {
    throw new Error('managed plugin record installedAt invalid');
  }

  const hasApprovalChannel = record.approvalChannel !== undefined;
  const hasApprovalRequestId = record.approvalRequestId !== undefined;
  if (hasApprovalChannel !== hasApprovalRequestId) {
    throw new Error('managed plugin record approval binding incomplete');
  }
  if (
    (hasApprovalChannel && !isNonEmptyString(record.approvalChannel)) ||
    (hasApprovalRequestId && !isNonEmptyString(record.approvalRequestId))
  ) {
    throw new Error('managed plugin record approval binding invalid');
  }
  if (manifest === null && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new Error('managed plugin record missing manifest diagnostic');
  }

  // EP-01/EP-02 integrity fields are all-or-nothing; absent = legacy record.
  const integrityKeys = [
    'contentDigest',
    'manifestVersion',
    'grantedPermissions',
    'permissionsDigest',
  ] as const;
  const presentIntegrityKeys = integrityKeys.filter((key) => record[key] !== undefined);
  let integrity:
    | Pick<
        ManagedPluginRecord,
        'contentDigest' | 'manifestVersion' | 'grantedPermissions' | 'permissionsDigest'
      >
    | undefined;
  if (presentIntegrityKeys.length > 0) {
    if (presentIntegrityKeys.length !== integrityKeys.length) {
      throw new Error('managed plugin record integrity binding incomplete');
    }
    if (
      typeof record.contentDigest !== 'string' ||
      !SHA256_HEX.test(record.contentDigest) ||
      typeof record.permissionsDigest !== 'string' ||
      !SHA256_HEX.test(record.permissionsDigest) ||
      (record.manifestVersion !== null && typeof record.manifestVersion !== 'string')
    ) {
      throw new Error('managed plugin record integrity binding invalid');
    }
    integrity = {
      contentDigest: record.contentDigest,
      manifestVersion: record.manifestVersion as string | null,
      grantedPermissions: parsePluginPermissionGrant(record.grantedPermissions),
      permissionsDigest: record.permissionsDigest,
    };
  }
  if (
    record.tenantSlug !== undefined &&
    (typeof record.tenantSlug !== 'string' || !isValidTenantSlug(record.tenantSlug))
  ) {
    throw new Error('managed plugin record tenantSlug invalid');
  }

  return {
    pluginId,
    trust: record.trust,
    trustReason: record.trustReason,
    resolvedSourcePath: record.resolvedSourcePath,
    managedPath: safeManagedDir,
    manifest,
    diagnostics,
    activationStatus: record.activationStatus,
    ...(hasApprovalChannel
      ? {
          approvalChannel: record.approvalChannel as string,
          approvalRequestId: record.approvalRequestId as string,
        }
      : {}),
    installedAt: record.installedAt,
    ...(integrity ?? {}),
    ...(typeof record.tenantSlug === 'string' ? { tenantSlug: record.tenantSlug } : {}),
  };
}

function approvalBindingOf(record: ManagedPluginRecord): PluginApprovalBinding | undefined {
  if (!record.contentDigest || !record.permissionsDigest || record.manifestVersion === undefined) {
    return undefined;
  }
  return {
    pluginId: record.pluginId,
    trust: record.trust,
    resolvedSourcePath: record.resolvedSourcePath,
    contentDigest: record.contentDigest,
    manifestVersion: record.manifestVersion,
    permissionsDigest: record.permissionsDigest,
  };
}

function loadBoundPluginApproval(record: ManagedPluginRecord): ApprovalRequestRecord | undefined {
  if (!record.approvalChannel || !record.approvalRequestId) return undefined;
  const binding = approvalBindingOf(record);
  if (!binding) return undefined;
  const approval = loadApprovalRequest(record.approvalChannel, record.approvalRequestId);
  if (!approval) return undefined;
  if (approval.correlationId !== pluginApprovalCorrelationId(binding)) {
    return undefined;
  }
  if (
    approval.accountability?.payloadHash !== pluginApprovalPayloadHash(binding) ||
    approval.accountability?.effectBinding !== pluginApprovalEffectBinding(record.pluginId)
  ) {
    return undefined;
  }
  return approval;
}

/**
 * Re-derives everything the approval is bound to from the managed copy on
 * disk: content digest, manifest version and the narrowed grant (current
 * policy, verified trust, recorded tenant). Any drift or any error while
 * re-deriving is a mismatch — fail closed.
 */
function verifyManagedPluginIntegrity(record: ManagedPluginRecord): PluginIntegrity {
  if (
    !record.contentDigest ||
    !record.permissionsDigest ||
    !record.grantedPermissions ||
    record.manifestVersion === undefined
  ) {
    return 'legacy';
  }
  try {
    if (computePluginContentDigest(record.managedPath) !== record.contentDigest) return 'mismatch';
    if (permissionsDigest(record.grantedPermissions) !== record.permissionsDigest) {
      return 'mismatch';
    }
    const { manifest, diagnostics } = readPluginManifestSafely(record.managedPath);
    if (!manifest || diagnostics.some((d) => d.severity === 'error')) return 'mismatch';
    if ((manifest.version ?? null) !== record.manifestVersion) return 'mismatch';
    const { granted } = narrowPluginPermissions(
      manifestPermissionRequest(manifest).request,
      loadPluginPermissionPolicy(),
      { trust: record.trust, ...(record.tenantSlug ? { tenantSlug: record.tenantSlug } : {}) }
    );
    return permissionsDigest(granted) === record.permissionsDigest ? 'verified' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

function verifyManagedPluginActivation(record: ManagedPluginRecord): ManagedPluginRecord {
  let trust = record.trust;
  let trustReason = record.trustReason;
  try {
    const derived = derivePluginTrustLabel(record.resolvedSourcePath).label;
    if (trust === 'official' && derived !== 'official') {
      trust = 'third-party';
      trustReason =
        'Persisted official trust did not match source provenance; defaulting to third-party.';
    }
  } catch {
    if (trust === 'official') {
      trust = 'third-party';
      trustReason = 'Source provenance could not be verified; defaulting to third-party.';
    }
  }
  const verified = { ...record, trust, trustReason };
  const brokenManifest = verified.diagnostics.some((d) => d.severity === 'error');
  return {
    ...verified,
    activationStatus: resolveActivationStatus({
      diagnostics: verified.diagnostics,
      trust,
      integrity: brokenManifest ? 'legacy' : verifyManagedPluginIntegrity(verified),
      approval: loadBoundPluginApproval(verified),
    }),
  };
}

function readManagedRecord(managedDir: string): ManagedPluginRecord | null {
  const recordPath = path.join(managedDir, MANAGED_RECORD_FILENAME);
  if (!safeExistsSync(recordPath)) return null;
  try {
    return verifyManagedPluginActivation(loadManagedPluginRecordAtPath(recordPath, managedDir));
  } catch {
    return null;
  }
}

/** Load a managed plugin record through the shared schema and file boundary. */
export function loadManagedPluginRecordAtPath(
  recordPath: string,
  managedDir: string
): ManagedPluginRecord {
  const safeRecordPath = assertSafeRepositoryPath(recordPath, { allowMissingLeaf: false });
  if (!safeLstat(safeRecordPath).isFile()) {
    throw new Error(`managed plugin record must be a regular file: ${recordPath}`);
  }
  const validated = defineCatalog<ManagedPluginRecord>({
    id: 'managed-plugin-record',
    path: safeRecordPath,
    schema: MANAGED_RECORD_SCHEMA_PATH,
  }).load();
  return parseManagedPluginRecord(validated, managedDir);
}

function resolveManagedRoot(managedRoot?: string): string {
  return assertSafeRepositoryPath(managedRoot ? path.resolve(managedRoot) : defaultManagedRoot(), {
    allowMissingLeaf: true,
  });
}

/**
 * Installs a plugin: stage -> validate (containment + manifest diagnostics,
 * no execution) -> atomic rename into the managed directory. Trust is
 * derived from `params.sourcePath` alone. A broken manifest never throws —
 * it degrades to a diagnostic listing entry with `blocked_broken_manifest`.
 */
export function installPluginManaged(params: InstallPluginManagedParams): ManagedPluginRecord {
  // Managed installs own the shared plugin tree the way mission-controller
  // owns the rest of active/shared/ — run under that authority role so the
  // staging/rename/record writes are governed consistently regardless of the
  // caller's ambient role (mirrors approval-store's own `withRole` usage).
  return withExecutionContext('mission_controller', () => {
    const pluginId = normalizePluginId(params.pluginId);
    const tenantSlug = params.tenantSlug?.trim() || undefined;
    if (tenantSlug !== undefined && !isValidTenantSlug(tenantSlug)) {
      throw new Error(`[POLICY_VIOLATION] Invalid tenant slug: ${params.tenantSlug}`);
    }
    const managedRoot = resolveManagedRoot(params.managedRoot);
    const managedDir = assertSafeRepositoryPath(path.join(managedRoot, pluginId), {
      allowMissingLeaf: true,
    });
    const approvalChannel = params.approvalChannel?.trim() || DEFAULT_APPROVAL_CHANNEL;

    const trust = derivePluginTrustLabel(params.sourcePath, {
      curatedOriginPrefixes: params.curatedOriginPrefixes,
    });

    const stagingDir = assertSafeRepositoryPath(
      pathResolver.sharedTmp(`plugin-install/${pluginId}-${randomUUID()}`),
      { allowMissingLeaf: true }
    );
    safeRmSync(stagingDir);
    stagePluginDirectory(path.resolve(params.sourcePath), stagingDir);

    // Manifest is only ever JSON.parse'd — never required/imported/executed.
    const { manifest, diagnostics } = readPluginManifestSafely(stagingDir);

    // EP-02: narrow declared permissions before anything lands in the
    // managed tree. A malformed declaration is a broken manifest; a critical
    // capability narrowed to nothing aborts the install (nothing is staged).
    let request = parsePluginPermissionRequest(undefined);
    if (manifest) {
      try {
        const resolved = manifestPermissionRequest(manifest);
        request = resolved.request;
        if (resolved.legacyBlockIgnored) {
          diagnostics.push({
            code: 'manifest_legacy_permissions_ignored',
            message:
              "Manifest 'permissions' uses the Cowork v1 descriptive shape; it is not an EP-02 declaration, so no runtime permissions are granted.",
            severity: 'warning',
          });
        }
      } catch (err: unknown) {
        diagnostics.push({
          code: 'manifest_invalid_permissions',
          message: err instanceof Error ? err.message : String(err),
          severity: 'error',
        });
      }
    }
    const provides = manifest?.raw.provides;
    const officialOnlySeam = findDisallowedOfficialOnlySeam(
      isRecord(provides) && Array.isArray(provides.seams) ? provides.seams : [],
      trust.label
    );
    if (officialOnlySeam) {
      diagnostics.push({
        code: 'manifest_official_only_seam',
        message: `Manifest declares the official-only seam '${officialOnlySeam}', which a ${trust.label} plugin may not provide.`,
        severity: 'error',
      });
    }
    const brokenManifest = diagnostics.some((d) => d.severity === 'error');
    let narrowed: NarrowPluginPermissionsResult;
    try {
      narrowed = narrowPluginPermissions(
        brokenManifest ? parsePluginPermissionRequest(undefined) : request,
        loadPluginPermissionPolicy(),
        { trust: trust.label, ...(tenantSlug ? { tenantSlug } : {}) }
      );
    } catch (err) {
      safeRmSync(stagingDir);
      throw err;
    }
    if (!brokenManifest) {
      params.onPermissionsResolved?.({ pluginId, trust: trust.label, request, ...narrowed });
    }

    safeMkdir(managedRoot, { recursive: true });
    if (safeExistsSync(managedDir)) safeRmSync(managedDir);
    safeMoveSync(stagingDir, managedDir);

    const binding: PluginApprovalBinding = {
      pluginId,
      trust: trust.label,
      resolvedSourcePath: trust.resolvedSourcePath,
      contentDigest: computePluginContentDigest(managedDir),
      manifestVersion: manifest?.version ?? null,
      permissionsDigest: permissionsDigest(narrowed.granted),
    };

    let approval: ApprovalRequestRecord | undefined;
    if (trust.label !== 'official' && !brokenManifest) {
      approval = ensurePluginApprovalRequest({
        binding,
        permissionSummary: summarizePermissionDiff(narrowed.diff),
        requestedBy: params.requestedBy,
        channel: approvalChannel,
        missionId: params.missionId,
      });
    }

    const record: ManagedPluginRecord = {
      pluginId,
      trust: trust.label,
      trustReason: trust.reason,
      resolvedSourcePath: trust.resolvedSourcePath,
      managedPath: managedDir,
      manifest,
      diagnostics,
      activationStatus: resolveActivationStatus({
        diagnostics,
        trust: trust.label,
        integrity: 'verified',
        approval,
      }),
      approvalChannel: approval ? approvalChannel : undefined,
      approvalRequestId: approval?.id,
      installedAt: nowIso(),
      contentDigest: binding.contentDigest,
      manifestVersion: binding.manifestVersion,
      grantedPermissions: narrowed.granted,
      permissionsDigest: binding.permissionsDigest,
      ...(tenantSlug ? { tenantSlug } : {}),
    };
    writeManagedRecord(managedDir, record);
    return record;
  });
}

/**
 * Re-reads the bound approval request (if any) and refreshes the persisted
 * activation status. Call after a human decides the approval request — this
 * never re-stages or re-copies plugin content, and never executes anything.
 */
export function refreshManagedPluginActivation(
  pluginId: string,
  managedRoot?: string
): ManagedPluginRecord | null {
  const root = resolveManagedRoot(managedRoot);
  const managedDir = assertSafeRepositoryPath(path.join(root, normalizePluginId(pluginId)), {
    allowMissingLeaf: true,
  });
  // readManagedRecord re-verifies trust, content/permission digests and the
  // bound approval; only persist when the verified status differs.
  const record = readManagedRecord(managedDir);
  if (!record) return null;
  let persistedStatus: PluginActivationStatus | undefined;
  try {
    persistedStatus = loadManagedPluginRecordAtPath(
      path.join(managedDir, MANAGED_RECORD_FILENAME),
      managedDir
    ).activationStatus;
  } catch {
    persistedStatus = undefined;
  }
  if (persistedStatus === record.activationStatus) return record;

  return withExecutionContext('mission_controller', () => {
    writeManagedRecord(managedDir, record);
    return record;
  });
}

/**
 * Lists installed plugins from the managed directory only (never the
 * staging/temp area, never an arbitrary source). Broken manifests are
 * surfaced as diagnostic entries and are never executed — fail-open display,
 * fail-closed execution.
 */
export function listManagedPlugins(managedRoot?: string): ManagedPluginRecord[] {
  const root = resolveManagedRoot(managedRoot);
  if (!safeExistsSync(root)) return [];

  const entries: ManagedPluginRecord[] = [];
  for (const name of safeReaddir(root).sort(codepointCompare)) {
    const managedDir = path.join(root, name);
    const stat = safeLstat(managedDir);
    if (!stat.isDirectory()) continue; // never treat stray files as plugins

    const record = readManagedRecord(managedDir);
    if (record) {
      entries.push(record);
      continue;
    }

    // No managed-installer record (e.g. hand-placed directory) — degrade to
    // a diagnostic listing entry without executing or trusting anything.
    const { manifest, diagnostics } = readPluginManifestSafely(managedDir);
    const effectiveDiagnostics: PluginManifestDiagnostic[] = diagnostics.length
      ? diagnostics
      : [
          {
            code: 'managed_record_missing',
            message:
              'No managed-installer record found; provenance could not be verified, so this entry is treated as third-party and blocked pending approval.',
            severity: 'warning',
          },
        ];
    entries.push({
      pluginId: name,
      trust: 'third-party',
      trustReason:
        'No managed-installer record found; provenance unknown, defaulting to third-party.',
      resolvedSourcePath: managedDir,
      managedPath: managedDir,
      manifest,
      diagnostics: effectiveDiagnostics,
      activationStatus: resolveActivationStatus({
        diagnostics: effectiveDiagnostics,
        trust: 'third-party',
        integrity: 'legacy',
      }),
      installedAt: '',
    });
  }
  return entries;
}

export function isManagedPluginActivationAllowed(
  entry: Pick<ManagedPluginRecord, 'activationStatus'>
): boolean {
  return entry.activationStatus === 'activatable';
}

setManagedPluginGrantLookup((sourcePath, managedRoot) =>
  listManagedPlugins(managedRoot).find(
    (record) =>
      isManagedPluginActivationAllowed(record) && isPathContainedIn(record.managedPath, sourcePath)
  )
);
