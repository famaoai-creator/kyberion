import { appendJsonLine, parseSafeJsonInput, readJson } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
/**
 * Plugin packs — git-imported plugin collections (QM-07, ported from qm's
 * skill-pack store).
 *
 * A pack is a git repository whose root (or immediate subdirectories, or a
 * `plugins/` directory) contains kyberion plugin sources. Importing a pack
 * stages every contained plugin through the EXISTING provenance-gated
 * managed-install flow (`installPluginManaged`) — pack plugins are
 * third-party by construction, so each lands `pending_approval` and is never
 * executed until a human approves it (KD-06 fail-closed load contract).
 *
 * Lifecycle guarantees (qm semantics):
 *  - `pinned` packs re-import only when explicitly asked; `tracked` packs are
 *    expected to be re-synced and report the previously imported commit.
 *  - A pack can NEVER claim a plugin id that a non-pack (hand-installed)
 *    managed plugin already owns, nor one owned by a different pack — the
 *    collision is recorded and skipped, not overwritten.
 *  - Plugins removed upstream are ARCHIVED in the registry, never deleted.
 *  - Every import attempt — success or failure — appends an ImportRecord.
 *  - Registry writes are fingerprint-guarded: if the pack entry changed while
 *    the (slow) fetch ran, the import fails with "pack changed while
 *    fetching" instead of clobbering.
 *
 * SSRF guard (honest scope): the pack URL must be https:// with a non-IP,
 * non-userinfo hostname. DNS-rebinding at clone time is out of scope — the
 * fetch runs `git clone` with the host's own resolver, same as any operator
 * clone. Local paths are permitted only via the explicit `allowLocalPath`
 * test/dev flag, mirroring qm's `allowLocalRepos` default-off.
 */

import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExecResult,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeLstat,
  safeWriteFile,
} from './secure-io.js';
import { auditChain } from './audit-chain.js';
import { logger } from './core.js';
import {
  installPluginManaged,
  listManagedPlugins,
  type ManagedPluginRecord,
} from './plugin-managed-install.js';

export type PluginPackSyncMode = 'pinned' | 'tracked';

export interface PluginPackPluginEntry {
  plugin_id: string;
  status: 'active' | 'archived';
  activation_status: string;
  archived_at?: string;
}

export interface PluginPackRecord {
  pack_id: string;
  url: string;
  ref?: string;
  sync_mode: PluginPackSyncMode;
  commit?: string;
  status: 'active' | 'archived';
  imported_at: string;
  plugins: PluginPackPluginEntry[];
}

export interface PluginPackRegistry {
  version: '1';
  packs: PluginPackRecord[];
}

export interface PackImportRecord {
  pack_id: string;
  at: string;
  ok: boolean;
  url: string;
  ref?: string;
  commit?: string;
  installed: string[];
  archived: string[];
  skipped: Array<{ plugin_id: string; reason: string }>;
  error?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function normalizeSkippedEntry(value: unknown): { plugin_id: string; reason: string } | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.plugin_id === 'string' && typeof value.reason === 'string'
    ? { plugin_id: value.plugin_id, reason: value.reason }
    : undefined;
}

/** Normalize persisted pack-import telemetry before exposing it to callers. */
export function normalizePackImportRecord(value: unknown): PackImportRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.pack_id !== 'string' ||
    typeof value.at !== 'string' ||
    typeof value.ok !== 'boolean' ||
    typeof value.url !== 'string' ||
    !isStringArray(value.installed) ||
    !isStringArray(value.archived) ||
    !Array.isArray(value.skipped)
  ) {
    return undefined;
  }
  const skipped = value.skipped.flatMap((entry) => {
    const normalized = normalizeSkippedEntry(entry);
    return normalized ? [normalized] : [];
  });
  if (skipped.length !== value.skipped.length) return undefined;
  for (const field of ['ref', 'commit', 'error'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  return {
    pack_id: value.pack_id,
    at: value.at,
    ok: value.ok,
    url: value.url,
    ...(typeof value.ref === 'string' ? { ref: value.ref } : {}),
    ...(typeof value.commit === 'string' ? { commit: value.commit } : {}),
    installed: value.installed,
    archived: value.archived,
    skipped,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

export interface ImportPluginPackParams {
  url: string;
  ref?: string;
  syncMode?: PluginPackSyncMode;
  requestedBy?: string;
  approvalChannel?: string;
  managedRoot?: string;
  registryDir?: string;
  /** Test/dev only: treat `url` as a local directory instead of cloning. */
  allowLocalPath?: boolean;
  /** Injectable fetcher for tests; defaults to a shallow https git clone. */
  fetcher?: (url: string, ref: string | undefined, destDir: string) => { commit?: string };
}

export interface ImportPluginPackResult {
  pack: PluginPackRecord;
  importRecord: PackImportRecord;
  installed: ManagedPluginRecord[];
}

function registryDir(override?: string): string {
  return assertSafeRepositoryPath(override || pathResolver.shared('plugins'), {
    allowMissingLeaf: true,
  });
}

function registryPath(override?: string): string {
  return assertSafeRepositoryPath(path.join(registryDir(override), 'packs.json'), {
    allowMissingLeaf: true,
  });
}

function importLogPath(override?: string): string {
  return assertSafeRepositoryPath(path.join(registryDir(override), 'pack-imports.jsonl'), {
    allowMissingLeaf: true,
  });
}

export function loadPluginPackRegistry(override?: string): PluginPackRegistry {
  const file = registryPath(override);
  if (!safeExistsSync(file)) return { version: '1', packs: [] };
  try {
    const parsed = readJson<Partial<PluginPackRegistry>>(file);
    if (parsed && parsed.version === '1' && Array.isArray(parsed.packs)) {
      return parsed as PluginPackRegistry;
    }
  } catch (error) {
    logger.warn(`[plugin-pack] unreadable pack registry (starting empty): ${error}`);
  }
  return { version: '1', packs: [] };
}

function saveRegistry(registry: PluginPackRegistry, override?: string): void {
  safeMkdir(registryDir(override), { recursive: true });
  safeWriteFile(registryPath(override), JSON.stringify(registry, null, 2));
}

function appendImportRecord(record: PackImportRecord, override?: string): void {
  safeMkdir(registryDir(override), { recursive: true });
  appendJsonLine(importLogPath(override), record);
  try {
    auditChain.record({
      agentId: 'plugin-pack',
      action: 'plugin_pack.import',
      operation: record.ok ? 'import' : 'import_failed',
      result: record.ok ? 'completed' : 'failed',
      reason: record.ok
        ? `imported ${record.installed.length} plugin(s), archived ${record.archived.length}, skipped ${record.skipped.length}`
        : record.error || 'import failed',
      metadata: {
        pack_id: record.pack_id,
        url: record.url,
        ref: record.ref,
        commit: record.commit,
        installed: record.installed,
        archived: record.archived,
        skipped: record.skipped,
      },
    });
  } catch (error) {
    logger.warn(`[plugin-pack] import audit failed (ignored): ${error}`);
  }
}

export function listPackImportRecords(limit = 50, override?: string): PackImportRecord[] {
  const file = importLogPath(override);
  if (!safeExistsSync(file)) return [];
  const records: PackImportRecord[] = [];
  for (const line of String(safeReadFile(file, { encoding: 'utf8' })).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = normalizePackImportRecord(
        parseSafeJsonInput(trimmed, 'plugin pack import record')
      );
      if (record) records.push(record);
      else logger.warn('[plugin-pack] skipping malformed import record line');
    } catch {
      logger.warn('[plugin-pack] skipping unparseable import record line');
    }
  }
  return records.slice(-limit);
}

const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\])$/;

function isNumericShorthandHost(host: string): boolean {
  // 2130706433 / 0x7f000001 / 127.1 style loopback shorthands: every label is
  // decimal or hex — a real DNS name has at least one alphabetic label.
  return host.split('.').every((label) => /^\d+$/.test(label) || /^0x[0-9a-f]+$/i.test(label));
}

export function assertSafePackUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[plugin-pack] invalid pack URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`[plugin-pack] pack URLs must be https:// (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('[plugin-pack] pack URLs must not carry userinfo credentials');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    IP_LITERAL.test(host) ||
    isNumericShorthandHost(host) ||
    host === 'localhost' ||
    host.endsWith('.local')
  ) {
    throw new Error(`[plugin-pack] pack host must be a public DNS name (got ${host})`);
  }
}

export function packIdFromUrl(url: string): string {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  if (!slug) throw new Error(`[plugin-pack] cannot derive a pack id from ${url}`);
  return slug;
}

function defaultFetcher(
  url: string,
  ref: string | undefined,
  destDir: string
): { commit?: string } {
  const cloneArgs = ['clone', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, destDir];
  const clone = safeExecResult('git', cloneArgs);
  if (clone.status !== 0) {
    throw new Error(`[plugin-pack] git clone failed: ${String(clone.stderr || '').slice(0, 500)}`);
  }
  const rev = safeExecResult('git', ['rev-parse', 'HEAD'], { cwd: destDir });
  const commit = rev.status === 0 ? String(rev.stdout || '').trim() : undefined;
  return { ...(commit ? { commit } : {}) };
}

// Existing Kyberion and Claude Code packs remain supported alongside the
// Agent Plugins v1 portable root manifest.
const MANIFEST_NAMES = ['plugin-manifest.json', '.claude-plugin/plugin.json', 'plugin.json'];

function manifestPathFor(dir: string, name: string): string | null {
  try {
    const manifestPath = assertSafeRepositoryPath(path.join(dir, name));
    if (!safeExistsSync(manifestPath) || !safeLstat(manifestPath).isFile()) return null;
    return manifestPath;
  } catch {
    return null;
  }
}

function hasManifest(dir: string): boolean {
  return MANIFEST_NAMES.some((name) => manifestPathFor(dir, name) !== null);
}

function manifestPluginId(dir: string): string | undefined {
  for (const name of MANIFEST_NAMES) {
    const manifestPath = manifestPathFor(dir, name);
    if (!manifestPath) continue;
    try {
      const parsed = readJson<unknown>(manifestPath);
      if (!isRecord(parsed)) continue;
      const candidate =
        typeof parsed.plugin_id === 'string'
          ? parsed.plugin_id.trim()
          : typeof parsed.name === 'string'
            ? parsed.name.trim()
            : '';
      if (candidate) return candidate;
    } catch {
      // The managed-install path records malformed manifests as diagnostics.
      // Discovery should continue looking for another valid root candidate.
    }
  }
  return undefined;
}

/**
 * Root itself, immediate subdirectories, and plugins/<dir> entries with a
 * manifest. `rootPluginId` names a root-level-manifest pack — for remote
 * imports the root is a throwaway temp dir whose basename is nondeterministic,
 * so the caller passes the stable pack id (review B4).
 */
export function discoverPackPluginDirs(
  root: string,
  rootPluginId?: string
): Array<{ pluginId: string; dir: string }> {
  const found: Array<{ pluginId: string; dir: string }> = [];
  if (hasManifest(root)) {
    found.push({
      pluginId: rootPluginId || manifestPluginId(root) || path.basename(root),
      dir: root,
    });
    return found;
  }
  const roots = [root, path.join(root, 'plugins')].filter((candidate) => safeExistsSync(candidate));
  for (const base of roots) {
    for (const entry of safeReaddir(base)) {
      const name = String(entry);
      if (name.startsWith('.')) continue;
      const dir = path.join(base, name);
      if (hasManifest(dir)) found.push({ pluginId: name, dir });
    }
  }
  const seen = new Set<string>();
  return found.filter(({ pluginId }) => {
    if (seen.has(pluginId)) return false;
    seen.add(pluginId);
    return true;
  });
}

function packFingerprint(pack: PluginPackRecord | undefined): string {
  return pack ? `${pack.commit ?? ''}|${pack.imported_at}|${pack.plugins.length}` : 'absent';
}

export function importPluginPack(params: ImportPluginPackParams): ImportPluginPackResult {
  const url = String(params.url || '').trim();
  const syncMode: PluginPackSyncMode = params.syncMode ?? 'pinned';
  const isLocal = params.allowLocalPath === true && !/^[a-z]+:/i.test(url);
  if (!isLocal) assertSafePackUrl(url);
  const packId = isLocal
    ? `local-${path
        .basename(url)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')}`
    : packIdFromUrl(url);

  const registryBefore = loadPluginPackRegistry(params.registryDir);
  const before = registryBefore.packs.find((pack) => pack.pack_id === packId);
  // Review B2: the slug collapses punctuation, so two distinct URLs can map
  // to one pack_id — a same-id different-url entry is an impostor, refuse.
  if (before && before.url !== url) {
    throw new Error(
      `[plugin-pack] pack id ${packId} is already registered for a different URL (${before.url}); refusing to overwrite it`
    );
  }
  const beforeFingerprint = packFingerprint(before);

  const now = nowIso();
  const importRecord: PackImportRecord = {
    pack_id: packId,
    at: now,
    ok: false,
    url,
    ...(params.ref ? { ref: params.ref } : {}),
    installed: [],
    archived: [],
    skipped: [],
  };

  let fetchDir = url;
  let cleanup = false;
  try {
    let commit: string | undefined;
    if (!isLocal) {
      fetchDir = assertSafeRepositoryPath(
        pathResolver.sharedTmp(`plugin-pack-${packId}-${Date.now().toString(36)}`),
        { allowMissingLeaf: true }
      );
      cleanup = true;
      const fetched = (params.fetcher ?? defaultFetcher)(url, params.ref, fetchDir);
      commit = fetched.commit;
    }
    if (commit) importRecord.commit = commit;

    // A fetched remote root needs the stable pack id because its temp
    // directory name is nondeterministic. A local root package can use the
    // portable manifest name directly.
    const discovered = discoverPackPluginDirs(fetchDir, cleanup ? packId : undefined);
    if (discovered.length === 0) {
      throw new Error('[plugin-pack] no plugin directories with a manifest found in the pack');
    }

    // Collision map: plugin ids owned by hand-installs or by OTHER packs.
    const managed = listManagedPlugins(params.managedRoot);
    const ownedByOtherPack = new Map<string, string>();
    for (const pack of registryBefore.packs) {
      if (pack.pack_id === packId) continue;
      for (const plugin of pack.plugins) ownedByOtherPack.set(plugin.plugin_id, pack.pack_id);
    }
    const ownPluginIds = new Set((before?.plugins ?? []).map((plugin) => plugin.plugin_id));
    const handInstalled = new Set(
      managed
        .map((record) => record.pluginId)
        .filter((id) => !ownPluginIds.has(id) && !ownedByOtherPack.has(id))
    );

    const installed: ManagedPluginRecord[] = [];
    const entries: PluginPackPluginEntry[] = [];
    for (const { pluginId, dir } of discovered) {
      const otherPack = ownedByOtherPack.get(pluginId);
      if (otherPack) {
        importRecord.skipped.push({
          plugin_id: pluginId,
          reason: `claimed by pack ${otherPack}`,
        });
        continue;
      }
      if (handInstalled.has(pluginId)) {
        importRecord.skipped.push({
          plugin_id: pluginId,
          reason: 'foreign collision: a hand-installed managed plugin owns this id',
        });
        continue;
      }
      // Review B1: one bad plugin (invalid id, symlink violation, broken
      // staging) must skip-and-record, never abort a half-installed pack —
      // an abort here would leave earlier installs untracked and permanently
      // poison the pack as "foreign collisions" on re-import.
      let record: ManagedPluginRecord;
      try {
        record = installPluginManaged({
          pluginId,
          sourcePath: dir,
          ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
          ...(params.approvalChannel ? { approvalChannel: params.approvalChannel } : {}),
          ...(params.managedRoot ? { managedRoot: params.managedRoot } : {}),
        });
      } catch (error) {
        importRecord.skipped.push({
          plugin_id: pluginId,
          reason: `install failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      installed.push(record);
      importRecord.installed.push(pluginId);
      entries.push({
        plugin_id: pluginId,
        status: 'active',
        activation_status: record.activationStatus,
      });
    }

    // Upstream-removed plugins are archived, never deleted.
    for (const previous of before?.plugins ?? []) {
      if (entries.some((entry) => entry.plugin_id === previous.plugin_id)) continue;
      if (importRecord.skipped.some((skip) => skip.plugin_id === previous.plugin_id)) continue;
      entries.push({
        ...previous,
        status: 'archived',
        archived_at: previous.archived_at ?? now,
      });
      if (previous.status !== 'archived') importRecord.archived.push(previous.plugin_id);
    }

    // Fingerprint-guarded write: the slow fetch must not clobber concurrent
    // edits to THIS pack. Note (review B3): the guard protects the registry
    // entry, not the managed copies already staged above; and two concurrent
    // imports of DIFFERENT packs still race the whole-file write — accepted
    // for a single-host operator CLI, revisit if imports ever run unattended.
    const registryNow = loadPluginPackRegistry(params.registryDir);
    const currentFingerprint = packFingerprint(
      registryNow.packs.find((pack) => pack.pack_id === packId)
    );
    if (currentFingerprint !== beforeFingerprint) {
      throw new Error('[plugin-pack] pack changed while fetching — re-run the import');
    }
    const pack: PluginPackRecord = {
      pack_id: packId,
      url,
      ...(params.ref ? { ref: params.ref } : {}),
      sync_mode: syncMode,
      ...(commit ? { commit } : {}),
      status: 'active',
      imported_at: now,
      plugins: entries,
    };
    registryNow.packs = [...registryNow.packs.filter((entry) => entry.pack_id !== packId), pack];
    saveRegistry(registryNow, params.registryDir);

    importRecord.ok = true;
    appendImportRecord(importRecord, params.registryDir);
    return { pack, importRecord, installed };
  } catch (error) {
    importRecord.error = error instanceof Error ? error.message : String(error);
    appendImportRecord(importRecord, params.registryDir);
    throw error;
  } finally {
    if (cleanup) safeRmSync(fetchDir, { recursive: true, force: true });
  }
}
