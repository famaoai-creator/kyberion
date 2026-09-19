import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { safeExecResult, safeExistsSync, assertSafeRepositoryPath } from './secure-io.js';
import { resolveManagedToolPythonBin } from './tool-runtime-registry.js';

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
      /\{\{\s*([^}]+)\s*\}\}/gu,
      (match: string, key: string) => variables[key] ?? match
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
