import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getProcessEnv } from './foundation/process-env.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeStat,
  assertSafeRepositoryPath,
} from './secure-io.js';
import {
  ensureTrustedRoot,
  readTrustedFile,
  realpathOfDeepestAncestor,
  relativeInside,
  removeQuietly,
  resolvePrivateCacheDir,
  writeTrustedFile,
} from '#private-host-cache';
import {
  locateManagedToolPythonBin,
  resolveManagedToolPythonBin,
} from './tool/tool-runtime-registry.js';

export type LocalSttBackend = string;
export type LocalSttSource = string;
export type LocalSttPlatform = 'any' | 'darwin' | 'linux' | 'win32';

export interface LocalSttProbe {
  kind: 'executable' | 'python_module' | 'managed_python_module' | 'native_script';
  commands: string[];
  version_args?: string[];
  module?: string;
  script_path?: string;
  tool_id?: string;
}

export interface LocalSttBackendRecord {
  backend_id: string;
  display_name: string;
  status: 'active' | 'disabled';
  priority: number;
  platforms: LocalSttPlatform[];
  source: LocalSttSource;
  verification: 'executable' | 'python-module' | 'native-script';
  probe: LocalSttProbe;
  connection: Record<string, unknown>;
  detail: string;
}

export interface LocalSttDiscoveryRegistry {
  version: string;
  backends: LocalSttBackendRecord[];
}

export interface LocalSttCandidate {
  backend: LocalSttBackend;
  display_name: string;
  source: LocalSttSource;
  priority: number;
  executable?: string;
  python_bin?: string;
  version?: string;
  /** Detection proves the executable/native bridge exists, not that a model is cached. */
  verification: LocalSttBackendRecord['verification'];
  detail: string;
  connection: Record<string, unknown>;
}

type ExecResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
};

export interface LocalSttDiscoveryOptions {
  platform?: NodeJS.Platform;
  exec?: (command: string, args: string[]) => ExecResult;
  scriptAvailable?: boolean;
  registry?: LocalSttDiscoveryRegistry;
}

const REGISTRY_PATH = pathResolver.knowledge(
  'product/governance/local-stt-discovery-registry.json'
);
const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/local-stt-discovery-registry.schema.json'
);
const registryCatalog = defineCatalog<LocalSttDiscoveryRegistry>({
  id: 'local-stt-discovery-registry',
  path: REGISTRY_PATH,
  schema: REGISTRY_SCHEMA_PATH,
});

const DEFAULT_EXEC: NonNullable<LocalSttDiscoveryOptions['exec']> = (command, args) =>
  safeExecResult(command, args, { timeoutMs: 10_000, maxOutputMB: 2 });

export function loadLocalSttDiscoveryRegistry(): LocalSttDiscoveryRegistry {
  return registryCatalog.load();
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

function commandResolver(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

function supportsPlatform(record: LocalSttBackendRecord, platform: NodeJS.Platform): boolean {
  return (
    record.platforms.includes('any') || record.platforms.includes(platform as LocalSttPlatform)
  );
}

function locateExecutable(
  command: string,
  platform: NodeJS.Platform,
  versionArgs: string[],
  exec: NonNullable<LocalSttDiscoveryOptions['exec']>
): { path: string; version?: string } | null {
  const located = exec(commandResolver(platform), [command]);
  if (located.status !== 0) return null;
  const executable = firstLine(located.stdout);
  if (!executable || !path.isAbsolute(executable)) return null;

  const version = exec(executable, versionArgs);
  return {
    path: executable,
    ...(version.status === 0 && firstLine(version.stdout)
      ? { version: firstLine(version.stdout) }
      : {}),
  };
}

function probeExecutable(
  record: LocalSttBackendRecord,
  platform: NodeJS.Platform,
  exec: NonNullable<LocalSttDiscoveryOptions['exec']>
): { executable: string; version?: string } | null {
  const versionArgs = record.probe.version_args || ['--version'];
  for (const command of record.probe.commands) {
    const found = locateExecutable(command, platform, versionArgs, exec);
    if (found)
      return { executable: found.path, ...(found.version ? { version: found.version } : {}) };
  }
  return null;
}

function probePythonModule(
  record: LocalSttBackendRecord,
  platform: NodeJS.Platform,
  exec: NonNullable<LocalSttDiscoveryOptions['exec']>
): { pythonBin: string; version?: string } | null {
  const moduleName = record.probe.module;
  if (!moduleName) return null;
  const seen = new Set<string>();
  for (const command of record.probe.commands) {
    const located = locateExecutable(
      command,
      platform,
      record.probe.version_args || ['--version'],
      exec
    );
    if (!located || seen.has(located.path)) continue;
    seen.add(located.path);
    const probe = exec(located.path, [
      '-c',
      `import ${moduleName}; print(getattr(${moduleName}, '__version__', 'installed'))`,
    ]);
    if (probe.status === 0) {
      return {
        pythonBin: located.path,
        ...(firstLine(probe.stdout) ? { version: firstLine(probe.stdout) } : {}),
      };
    }
  }
  return null;
}

function probeManagedPythonModule(
  record: LocalSttBackendRecord,
  exec: NonNullable<LocalSttDiscoveryOptions['exec']>
): { pythonBin: string; version?: string } | null {
  if (!record.probe.module || !record.probe.tool_id) return null;
  const pythonBin = resolveManagedToolPythonBin(record.probe.tool_id);
  if (!pythonBin) return null;
  const probe = exec(pythonBin, [
    '-c',
    `import ${record.probe.module}; print(getattr(${record.probe.module}, '__version__', 'installed'))`,
  ]);
  if (probe.status !== 0) return null;
  return {
    pythonBin,
    ...(firstLine(probe.stdout) ? { version: firstLine(probe.stdout) } : {}),
  };
}

function nativeScriptAvailable(
  record: LocalSttBackendRecord,
  options: LocalSttDiscoveryOptions
): boolean {
  if (options.scriptAvailable !== undefined) return options.scriptAvailable;
  if (!record.probe.script_path) return false;
  try {
    return safeExistsSync(assertSafeRepositoryPath(pathResolver.resolve(record.probe.script_path)));
  } catch {
    return false;
  }
}

function interpolateConnection(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const out: string[] = [];
    let cursor = 0;
    for (;;) {
      const open = value.indexOf('{{', cursor);
      if (open < 0) break;
      const close = value.indexOf('}}', open + 2);
      if (close < 0) break;
      const inner = value.slice(open + 2, close);
      if (inner.includes('{') || inner.includes('}')) break;
      out.push(value.slice(cursor, open));
      out.push(variables[inner.trim()] ?? value.slice(open, close + 2));
      cursor = close + 2;
    }
    out.push(value.slice(cursor));
    return out.join('');
  }
  if (Array.isArray(value)) return value.map((entry) => interpolateConnection(entry, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateConnection(entry, variables)])
    );
  }
  return value;
}

function buildCandidate(
  record: LocalSttBackendRecord,
  variables: Record<string, string>,
  version?: string
): LocalSttCandidate {
  return {
    backend: record.backend_id,
    display_name: record.display_name,
    source: record.source,
    priority: record.priority,
    ...(variables.executable ? { executable: variables.executable } : {}),
    ...(variables.python_bin ? { python_bin: variables.python_bin } : {}),
    ...(version ? { version } : {}),
    verification: record.verification,
    detail: record.detail,
    connection: interpolateConnection(record.connection, variables) as Record<string, unknown>,
  };
}

/**
 * Run the governed discovery catalog. Tool names, platform support, priority,
 * probes, and connection fields are data; the runner only understands probe
 * kinds and does not encode backend-specific ordering.
 */
export function discoverLocalSttBackends(
  options: LocalSttDiscoveryOptions = {}
): LocalSttCandidate[] {
  // Only the host probe (default exec, registry and script check) is cached:
  // an injected exec or registry is a test or a what-if and always runs.
  const hostProbe =
    !options.exec &&
    !options.registry &&
    options.scriptAvailable === undefined &&
    (options.platform === undefined || options.platform === process.platform);
  if (!hostProbe) return runLocalSttDiscovery(options);
  const key = hostDiscoveryKey();
  const memoTtl = processMemoTtlMs();
  if (processMemo?.key === key && memoTtl > 0 && Date.now() - processMemo.createdAtMs <= memoTtl) {
    return cloneCandidates(withExistingBinaries(processMemo.candidates));
  }
  const cached = readDiscoveryDiskCache(key);
  const candidates = cached ?? runLocalSttDiscovery(options);
  if (memoTtl > 0) processMemo = { key, candidates, createdAtMs: Date.now() };
  if (!cached) writeDiscoveryDiskCache(key, candidates);
  return cloneCandidates(candidates);
}

/** A cached candidate whose binary was removed since the probe is dropped, not returned. */
function withExistingBinaries(candidates: LocalSttCandidate[]): LocalSttCandidate[] {
  return candidates.filter((candidate) => {
    const binary = candidate.executable ?? candidate.python_bin;
    if (!binary) return true;
    try {
      return safeExistsSync(binary);
    } catch {
      return false;
    }
  });
}

/**
 * Host discovery cache. Discovery runs `which` / `--version` / `python -c import`
 * for every python3.x in the registry, and a process asks for it from several
 * bridge installers, so one process probed every interpreter twice.
 *
 * - Key: platform, PATH, registry content, and each managed python bin with
 *   its mtime (a new or recreated managed runtime changes the key).
 * - Per process: one probe per key, for the same TTL as the disk cache.
 * - Managed-tool installers (`voice setup --apply`, `tool-runtime setup`,
 *   `env:bootstrap --apply`) call `resetLocalSttDiscoveryCache({ disk: true })`
 *   when they finish, so a backend they just installed is seen at once. A
 *   `pip install` into an existing runtime by hand is seen after one TTL.
 * - A cached candidate whose binary no longer exists is dropped on a hit.
 * - Across processes: the result is kept for `KYBERION_STT_DISCOVERY_CACHE_TTL_MS`
 *   (default 10 minutes, 0 = off; off under Vitest unless set) in
 *   `node_modules/.cache/kyberion-stt-discovery/candidates.json`, a private host
 *   cache (libs/core/private-host-cache.mjs): outside every persona-writable
 *   tree, 0700/0600, owner and mode checked on read, off on Windows unless
 *   `KYBERION_WINDOWS_PRIVATE_CACHE=1`. A cached binary path decides what the
 *   speech-to-text bridge executes (review H2: a persona-writable cache let a
 *   data-only role point it at its own script). The file therefore stores only
 *   (backend, source, binary, version); a hit rebuilds each candidate from the
 *   governed registry and accepts its binary only where the probe could have
 *   found it — a managed-runtime python of that backend's tool, or a PATH
 *   directory outside the repository's data trees. Anything else discards the
 *   whole file and re-probes.
 */
let processMemo: { key: string; candidates: LocalSttCandidate[]; createdAtMs: number } | null =
  null;

const DEFAULT_DISK_CACHE_TTL_MS = 10 * 60 * 1000;
const DISK_CACHE_VERSION = 2;
const DISK_CACHE_NAME = 'kyberion-stt-discovery';
const DATA_TREES = new Set(['active', 'knowledge', 'customer', 'vault']);

interface DiscoveryDiskEntry {
  backend: string;
  source: string;
  executable?: string;
  python_bin?: string;
  version?: string;
}

interface DiscoveryDiskCache {
  version: number;
  key: string;
  written_at_ms: number;
  entries: DiscoveryDiskEntry[];
}

function cloneCandidates(candidates: LocalSttCandidate[]): LocalSttCandidate[] {
  return structuredClone(candidates);
}

function hostDiscoveryKey(): string {
  let registryText: string;
  try {
    registryText = JSON.stringify(loadLocalSttDiscoveryRegistry());
  } catch {
    registryText = 'unreadable';
  }
  return createHash('sha256')
    .update(`v${DISK_CACHE_VERSION}\0${process.platform}\0${process.arch}\0`)
    .update(`${getProcessEnv('PATH') ?? ''}\0`)
    .update(registryText)
    .update(`\0${managedRuntimeFingerprint()}`)
    .digest('hex');
}

/** Each managed-runtime python bin the registry probes, with its mtime (or `absent`). */
function managedRuntimeFingerprint(): string {
  let registry: LocalSttDiscoveryRegistry;
  try {
    registry = loadLocalSttDiscoveryRegistry();
  } catch {
    return 'registry-unreadable';
  }
  const toolIds = [
    ...new Set(
      registry.backends
        .filter((record) => record.probe.kind === 'managed_python_module' && record.probe.tool_id)
        .map((record) => String(record.probe.tool_id))
    ),
  ].sort();
  return toolIds
    .map((toolId) => {
      try {
        const bin = locateManagedToolPythonBin(toolId);
        if (!bin) return `${toolId}=absent`;
        return `${toolId}=${bin}@${managedRuntimeStamp(bin)}`;
      } catch {
        return `${toolId}=unknown`;
      }
    })
    .join('|');
}

/**
 * Change stamp of a managed runtime: the lstat mtime of its python bin (a
 * recreated venv replaces the link even when it points at the same
 * interpreter, whose own mtime does not move) and the mtime of each
 * site-packages directory (a `pip install` into the runtime adds entries there).
 */
function managedRuntimeStamp(bin: string): string {
  const parts = [String(safeLstat(bin).mtimeMs)];
  const envDir = path.dirname(path.dirname(bin));
  const libDirs =
    process.platform === 'win32'
      ? [path.join(envDir, 'Lib')]
      : (() => {
          const lib = path.join(envDir, 'lib');
          try {
            return safeReaddir(lib)
              .filter((name) => name.startsWith('python'))
              .sort()
              .map((name) => path.join(lib, name));
          } catch {
            return [];
          }
        })();
  for (const libDir of libDirs) {
    const sitePackages = path.join(libDir, 'site-packages');
    try {
      parts.push(`${path.basename(libDir)}:${safeStat(sitePackages).mtimeMs}`);
    } catch {
      /* no site-packages yet */
    }
  }
  return parts.join(',');
}

/** Process memo lifetime: the configured TTL (0 = off), else the default, also under Vitest. */
function processMemoTtlMs(): number {
  const raw = getProcessEnv('KYBERION_STT_DISCOVERY_CACHE_TTL_MS');
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISK_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function diskCacheTtlMs(): number {
  const raw = getProcessEnv('KYBERION_STT_DISCOVERY_CACHE_TTL_MS');
  if (raw === undefined || raw.trim() === '') {
    return getProcessEnv('VITEST') ? 0 : DEFAULT_DISK_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** The cross-process cache file, or null when no private cache may be used here. */
export function localSttDiscoveryCachePath(): string | null {
  const dir = resolvePrivateCacheDir({
    projectRoot: pathResolver.rootDir(),
    name: DISK_CACHE_NAME,
    override: getProcessEnv('KYBERION_STT_DISCOVERY_CACHE_DIR') ?? '',
  });
  return dir ? path.join(dir, 'candidates.json') : null;
}

function sanitizeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = firstLine(value).slice(0, 200);
  return line || undefined;
}

/** Whether `binary` is a path the host probe could have produced for `record`. */
export function isProbeResolvableBinary(
  binary: unknown,
  record: LocalSttBackendRecord,
  env: NodeJS.ProcessEnv = process.env
): binary is string {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || binary.includes('\0')) {
    return false;
  }
  if (record.probe.kind === 'managed_python_module') {
    if (!record.probe.tool_id) return false;
    try {
      return locateManagedToolPythonBin(record.probe.tool_id) === binary;
    } catch {
      return false;
    }
  }
  const repoRoot = realpathOfDeepestAncestor(pathResolver.rootDir());
  for (const candidate of [binary, realpathOfDeepestAncestor(binary)]) {
    if (!candidate) return false;
    const rel = repoRoot ? relativeInside(repoRoot, candidate) : null;
    if (rel && DATA_TREES.has(rel.split(path.sep)[0])) return false;
  }
  // `which` answers `<PATH entry>/<command>`: the binary must sit directly in a PATH directory.
  const pathDirs = String(env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
  return pathDirs.includes(path.dirname(binary));
}

/** Rebuild candidates from the registry; null when any entry is not one the probe could produce. */
function rebuildCachedCandidates(entries: unknown): LocalSttCandidate[] | null {
  if (!Array.isArray(entries)) return null;
  let registry: LocalSttDiscoveryRegistry;
  try {
    registry = loadLocalSttDiscoveryRegistry();
  } catch {
    return null;
  }
  const candidates: LocalSttCandidate[] = [];
  for (const raw of entries as DiscoveryDiskEntry[]) {
    if (!raw || typeof raw !== 'object') return null;
    const record = registry.backends.find(
      (entry) =>
        entry.backend_id === raw.backend &&
        entry.source === raw.source &&
        entry.status === 'active' &&
        supportsPlatform(entry, process.platform)
    );
    if (!record) return null;
    const pythonKind =
      record.probe.kind === 'python_module' || record.probe.kind === 'managed_python_module';
    const binary = pythonKind ? raw.python_bin : raw.executable;
    if (!isProbeResolvableBinary(binary, record)) return null;
    const variables: Record<string, string> = pythonKind
      ? { python_bin: binary, source: record.source }
      : { executable: binary, source: record.source };
    candidates.push(buildCandidate(record, variables, sanitizeVersion(raw.version)));
  }
  return candidates;
}

function readDiscoveryDiskCache(key: string): LocalSttCandidate[] | null {
  const ttl = diskCacheTtlMs();
  if (ttl <= 0) return null;
  const file = localSttDiscoveryCachePath();
  if (!file) return null;
  try {
    if (!ensureTrustedRoot(path.dirname(file))) return null;
    const text = readTrustedFile(file);
    if (text === null) return null;
    const parsed = JSON.parse(text) as DiscoveryDiskCache;
    if (parsed?.version !== DISK_CACHE_VERSION || parsed.key !== key) return null;
    const age = Date.now() - Number(parsed.written_at_ms);
    if (!Number.isFinite(age) || age < 0 || age > ttl) return null;
    const candidates = rebuildCachedCandidates(parsed.entries);
    // Not something the probe could have written: drop the file, probe again.
    if (candidates === null) removeQuietly(file);
    return candidates ? withExistingBinaries(candidates) : null;
  } catch {
    return null;
  }
}

function writeDiscoveryDiskCache(key: string, candidates: LocalSttCandidate[]): void {
  if (diskCacheTtlMs() <= 0) return;
  const file = localSttDiscoveryCachePath();
  if (!file || !ensureTrustedRoot(path.dirname(file))) return;
  const body: DiscoveryDiskCache = {
    version: DISK_CACHE_VERSION,
    key,
    written_at_ms: Date.now(),
    entries: candidates.map((candidate) => ({
      backend: candidate.backend,
      source: candidate.source,
      ...(candidate.executable ? { executable: candidate.executable } : {}),
      ...(candidate.python_bin ? { python_bin: candidate.python_bin } : {}),
      ...(candidate.version ? { version: candidate.version } : {}),
    })),
  };
  // A cache that cannot be written only costs the next process a probe.
  writeTrustedFile(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** Forget the per-process result; `{ disk: true }` also drops the cross-process file. */
export function resetLocalSttDiscoveryCache(options: { disk?: boolean } = {}): void {
  processMemo = null;
  if (!options.disk) return;
  const file = localSttDiscoveryCachePath();
  if (file) removeQuietly(file);
}

function runLocalSttDiscovery(options: LocalSttDiscoveryOptions): LocalSttCandidate[] {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? DEFAULT_EXEC;
  const registry = options.registry ?? loadLocalSttDiscoveryRegistry();
  const candidates: LocalSttCandidate[] = [];

  for (const record of registry.backends) {
    if (record.status !== 'active' || !supportsPlatform(record, platform)) continue;
    if (record.probe.kind === 'native_script') {
      if (!nativeScriptAvailable(record, options)) continue;
      const found = probeExecutable(record, platform, exec);
      if (found) {
        candidates.push(
          buildCandidate(
            record,
            { executable: found.executable, source: record.source },
            found.version
          )
        );
      }
      continue;
    }
    if (record.probe.kind === 'python_module') {
      const found = probePythonModule(record, platform, exec);
      if (found) {
        candidates.push(
          buildCandidate(
            record,
            { python_bin: found.pythonBin, source: record.source },
            found.version
          )
        );
      }
      continue;
    }
    if (record.probe.kind === 'managed_python_module') {
      const found = probeManagedPythonModule(record, exec);
      if (found) {
        candidates.push(
          buildCandidate(
            record,
            { python_bin: found.pythonBin, source: record.source },
            found.version
          )
        );
      }
      continue;
    }
    const found = probeExecutable(record, platform, exec);
    if (found) {
      candidates.push(
        buildCandidate(
          record,
          { executable: found.executable, source: record.source },
          found.version
        )
      );
    }
  }

  return candidates;
}

export function selectPreferredLocalSttBackend(
  candidates = discoverLocalSttBackends()
): LocalSttCandidate | undefined {
  return [...candidates].sort(
    (left, right) => right.priority - left.priority || left.backend.localeCompare(right.backend)
  )[0];
}
