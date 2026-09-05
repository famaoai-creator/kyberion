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
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { parseSafeJsonInput, parseSafeJsonObjectValue } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { readTextFile } from './foundation/text.js';
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

export type PluginActivationStatus = 'activatable' | 'pending_approval' | 'blocked_broken_manifest';

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
}

const MANAGED_RECORD_FILENAME = '.kyberion-managed-plugin.json';
const MANAGED_RECORD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/managed-plugin-record.schema.json'
);
// Keep the Kyberion/Cowork and Claude Code locations first for compatibility,
// then accept the Agent Plugins v1 portable root manifest.
const MANIFEST_CANDIDATE_RELATIVE_PATHS = [
  'plugin-manifest.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
];
const DEFAULT_APPROVAL_CHANNEL = 'plugin-install';

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

/**
 * Reads a plugin manifest via JSON.parse only. Never requires/imports the
 * manifest or any plugin code — this function must stay side-effect free.
 */
function readPluginManifestSafely(pluginRoot: string): {
  manifest: PluginManifestInfo | null;
  diagnostics: PluginManifestDiagnostic[];
} {
  const diagnostics: PluginManifestDiagnostic[] = [];
  const candidatePath = MANIFEST_CANDIDATE_RELATIVE_PATHS.map((rel) =>
    path.join(pluginRoot, rel)
  ).find((candidate) => safeExistsSync(candidate));
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
      parseSafeJsonInput(readTextFile(candidatePath), `plugin manifest ${candidatePath}`, {
        preserveParseError: true,
      }),
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

function pluginApprovalCorrelationId(pluginId: string, resolvedSourcePath: string): string {
  return createHash('sha256')
    .update(`${pluginId}::${resolvedSourcePath}`)
    .digest('hex')
    .slice(0, 32);
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
  pluginId: string;
  trust: PluginTrustLabel;
  resolvedSourcePath: string;
  requestedBy?: string;
  channel: string;
  missionId?: string;
}): ApprovalRequestRecord {
  const correlationId = pluginApprovalCorrelationId(params.pluginId, params.resolvedSourcePath);
  const payloadHash = computeApprovalPayloadHash({
    plugin_id: params.pluginId,
    trust: params.trust,
    resolved_source_path: params.resolvedSourcePath,
  });
  const effectBinding = pluginApprovalEffectBinding(params.pluginId);

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
      title: `Approve third-party plugin activation: ${params.pluginId}`,
      summary: `Plugin '${params.pluginId}' was sourced from outside this repository's plugins/ tree (trust=${params.trust}) and defaults to cancelled until a human approves activation.`,
      details: `Resolved source path: ${params.resolvedSourcePath}`,
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

function resolveActivationStatus(params: {
  diagnostics: PluginManifestDiagnostic[];
  trust: PluginTrustLabel;
  approval?: ApprovalRequestRecord;
}): PluginActivationStatus {
  if (params.diagnostics.some((d) => d.severity === 'error')) return 'blocked_broken_manifest';
  if (params.trust === 'official') return 'activatable';
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
    record.activationStatus !== 'blocked_broken_manifest'
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
  };
}

function loadBoundPluginApproval(record: ManagedPluginRecord): ApprovalRequestRecord | undefined {
  if (!record.approvalChannel || !record.approvalRequestId) return undefined;
  const approval = loadApprovalRequest(record.approvalChannel, record.approvalRequestId);
  if (!approval) return undefined;
  if (
    approval.correlationId !==
    pluginApprovalCorrelationId(record.pluginId, record.resolvedSourcePath)
  ) {
    return undefined;
  }
  if (
    approval.accountability?.payloadHash !==
      computeApprovalPayloadHash({
        plugin_id: record.pluginId,
        trust: record.trust,
        resolved_source_path: record.resolvedSourcePath,
      }) ||
    approval.accountability?.effectBinding !== pluginApprovalEffectBinding(record.pluginId)
  ) {
    return undefined;
  }
  return approval;
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
  return {
    ...verified,
    activationStatus: resolveActivationStatus({
      diagnostics: verified.diagnostics,
      trust,
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

    safeMkdir(managedRoot, { recursive: true });
    if (safeExistsSync(managedDir)) safeRmSync(managedDir);
    safeMoveSync(stagingDir, managedDir);

    let approval: ApprovalRequestRecord | undefined;
    if (trust.label !== 'official' && !diagnostics.some((d) => d.severity === 'error')) {
      approval = ensurePluginApprovalRequest({
        pluginId,
        trust: trust.label,
        resolvedSourcePath: trust.resolvedSourcePath,
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
      activationStatus: resolveActivationStatus({ diagnostics, trust: trust.label, approval }),
      approvalChannel: approval ? approvalChannel : undefined,
      approvalRequestId: approval?.id,
      installedAt: nowIso(),
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
  const record = readManagedRecord(managedDir);
  if (!record) return null;
  if (record.activationStatus === 'blocked_broken_manifest') return record;
  if (record.trust === 'official' || !record.approvalRequestId || !record.approvalChannel)
    return record;

  const approval = loadApprovalRequest(record.approvalChannel, record.approvalRequestId);
  const nextStatus: PluginActivationStatus =
    approval?.status === 'approved' ? 'activatable' : 'pending_approval';
  if (nextStatus === record.activationStatus) return record;

  const updated: ManagedPluginRecord = { ...record, activationStatus: nextStatus };
  return withExecutionContext('mission_controller', () => {
    writeManagedRecord(managedDir, updated);
    return updated;
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
