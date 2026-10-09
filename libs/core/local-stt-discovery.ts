import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { defineCatalog } from './foundation/governed-catalog.js';
import { getProcessEnv } from './foundation/process-env.js';
import { readJsonIfPresent } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExecResult,
  safeExistsSync,
  safeWriteFile,
  safeMkdir,
  safeStat,
  assertSafeRepositoryPath,
} from './secure-io.js';
import { resolveStorageFloor, SYSTEM_PARTITION } from './storage-layout.js';
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
    return value.replace(
      /\{\{([^}]*)\}\}/gu,
      (match: string, key: string) => variables[key.trim()] ?? match
    );
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
  const candidates = cached ? withExistingBinaries(cached) : runLocalSttDiscovery(options);
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
 * - Across processes: the same result in the cache floor
 *   (`active/shared/cache/system/local-stt-discovery/candidates.json`) for
 *   `KYBERION_STT_DISCOVERY_CACHE_TTL_MS` (default 10 minutes). It holds host
 *   binary paths and versions only (system partition, no tenant data). A newly
 *   installed backend is therefore seen at the latest one TTL later, or at once
 *   after `resetLocalSttDiscoveryCache({ disk: true })` or deleting the file.
 *   Set the TTL to 0 to switch the disk cache off. It is off under Vitest unless
 *   the TTL is set explicitly, so a test never reads the operator's probe.
 */
let processMemo: { key: string; candidates: LocalSttCandidate[]; createdAtMs: number } | null =
  null;

const DEFAULT_DISK_CACHE_TTL_MS = 10 * 60 * 1000;
const DISK_CACHE_VERSION = 1;

interface DiscoveryDiskCache {
  version: number;
  key: string;
  written_at_ms: number;
  candidates: LocalSttCandidate[];
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
        return `${toolId}=${bin}@${safeStat(bin).mtimeMs}`;
      } catch {
        return `${toolId}=unknown`;
      }
    })
    .join('|');
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

export function localSttDiscoveryCachePath(): string {
  // vitestLivePath: under Vitest the file lives in the per-worker sandbox, so a
  // test that enables the disk cache never rewrites the operator's file.
  return pathResolver.vitestLivePath(
    resolveStorageFloor('cache', SYSTEM_PARTITION, 'local-stt-discovery', 'candidates.json')
  );
}

function readDiscoveryDiskCache(key: string): LocalSttCandidate[] | null {
  const ttl = diskCacheTtlMs();
  if (ttl <= 0) return null;
  try {
    const file = localSttDiscoveryCachePath();
    const parsed = readJsonIfPresent<DiscoveryDiskCache>(file);
    if (parsed?.version !== DISK_CACHE_VERSION || parsed.key !== key) return null;
    const age = Date.now() - Number(parsed.written_at_ms);
    if (!Number.isFinite(age) || age < 0 || age > ttl) return null;
    return Array.isArray(parsed.candidates) ? parsed.candidates : null;
  } catch {
    return null;
  }
}

function writeDiscoveryDiskCache(key: string, candidates: LocalSttCandidate[]): void {
  if (diskCacheTtlMs() <= 0) return;
  try {
    const file = localSttDiscoveryCachePath();
    safeMkdir(path.dirname(file), { recursive: true });
    const body: DiscoveryDiskCache = {
      version: DISK_CACHE_VERSION,
      key,
      written_at_ms: Date.now(),
      candidates,
    };
    // safeWriteFile writes a temp file and renames it: concurrent readers see a whole file.
    safeWriteFile(file, `${JSON.stringify(body, null, 2)}\n`);
  } catch {
    // A cache that cannot be written only costs the next process a probe.
  }
}

/** Forget the per-process result; `{ disk: true }` also drops the cross-process file. */
export function resetLocalSttDiscoveryCache(options: { disk?: boolean } = {}): void {
  processMemo = null;
  if (!options.disk) return;
  try {
    const file = localSttDiscoveryCachePath();
    if (safeExistsSync(file)) safeWriteFile(file, '{}\n');
  } catch {
    /* best effort */
  }
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
