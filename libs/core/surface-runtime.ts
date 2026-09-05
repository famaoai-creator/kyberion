import type { ValidateFunction } from 'ajv';
import * as path from 'node:path';
import * as net from 'node:net';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { createLogger } from './logger.js';

const logger = createLogger('surface-runtime');
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import type { RuntimeResourceKind, RuntimeShutdownPolicy } from './runtime-supervisor.js';

const SURFACE_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/runtime-surface-manifest.schema.json'
);
const SURFACE_STATE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/surface-runtime-state.schema.json'
);

export type SurfaceRuntimeKind = Extract<RuntimeResourceKind, 'gateway' | 'ui' | 'service'>;

export interface SurfaceRuntimeDefinition {
  id: string;
  kind: SurfaceRuntimeKind;
  description: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shutdownPolicy?: RuntimeShutdownPolicy;
  startupMode?: 'background' | 'workspace-app';
  ownerType?: string;
  port?: number;
  healthPath?: string;
  service_id?: string;
  preset_path?: string;
  enabled?: boolean;
}

export interface SurfaceRuntimeManifest {
  version: 1;
  surfaces: SurfaceRuntimeDefinition[];
}

export interface SurfaceRuntimeStateRecord {
  id: string;
  pid: number;
  resourceId: string;
  kind: SurfaceRuntimeKind;
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  startedAt: string;
  shutdownPolicy: RuntimeShutdownPolicy;
  metadata?: Record<string, unknown>;
}

export interface SurfaceRuntimeState {
  version: 1;
  surfaces: Record<string, SurfaceRuntimeStateRecord>;
}

export interface SurfaceHealthStatus {
  status: 'healthy' | 'unhealthy' | 'unknown';
  detail: string;
}

export interface SurfacePortStatus {
  occupied: boolean;
  detail: 'open' | 'closed' | 'timeout' | 'error';
}

export function readSurfaceLogTail(logPath: string, maxLines = 20): string[] {
  const safeLogPath = assertSafeRepositoryPath(logPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeLogPath)) return [];
  if (!safeLstat(safeLogPath).isFile()) {
    throw new Error(`[SURFACE_RUNTIME_RESOURCE] log must be a regular file: ${safeLogPath}`);
  }
  const content = safeReadFile(safeLogPath, { encoding: 'utf8' }) as string;
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

const DEFAULT_MANIFEST_PATH = 'knowledge/product/governance/active-surfaces.json';
const DEFAULT_MANIFEST_DIR = 'knowledge/product/governance/surfaces';
const STATE_PATH = pathResolver.shared('runtime/surfaces/state.json');
const LOG_DIR = pathResolver.shared('logs/surfaces');
let surfaceManifestValidateFn: ValidateFunction | null = null;

function assertSurfaceId(surfaceId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(surfaceId)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] invalid surface id: ${surfaceId}`);
  }
  return surfaceId;
}

function ensureSurfaceManifestValidator(): ValidateFunction {
  if (surfaceManifestValidateFn) return surfaceManifestValidateFn;
  surfaceManifestValidateFn = compileSchema(SURFACE_MANIFEST_SCHEMA_PATH);
  return surfaceManifestValidateFn;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

export function surfaceManifestPath(): string {
  return assertSafeRepositoryPath(pathResolver.resolve(DEFAULT_MANIFEST_PATH), {
    allowMissingLeaf: true,
  });
}

export function surfaceManifestDirectoryPath(): string {
  return assertSafeRepositoryPath(pathResolver.resolve(DEFAULT_MANIFEST_DIR), {
    allowMissingLeaf: true,
  });
}

export function surfaceManifestFilePath(surfaceId: string): string {
  return assertSafeRepositoryPath(
    path.join(surfaceManifestDirectoryPath(), `${assertSurfaceId(surfaceId)}.json`),
    { allowMissingLeaf: true }
  );
}

function surfaceManifestCatalog(filePath: string) {
  return defineCatalog<SurfaceRuntimeManifest>({
    id: 'surface-runtime-manifest',
    path: filePath,
    schema: SURFACE_MANIFEST_SCHEMA_PATH,
  });
}

function surfaceStateCatalog(filePath: string) {
  return defineCatalog<SurfaceRuntimeState>({
    id: 'surface-runtime-state',
    path: filePath,
    schema: SURFACE_STATE_SCHEMA_PATH,
  });
}

export function surfaceStatePath(): string {
  return assertSafeRepositoryPath(STATE_PATH, { allowMissingLeaf: true });
}

export function surfaceLogPath(surfaceId: string): string {
  const safeLogDir = assertSafeRepositoryPath(LOG_DIR, { allowMissingLeaf: true });
  if (!safeExistsSync(safeLogDir)) safeMkdir(safeLogDir, { recursive: true });
  return assertSafeRepositoryPath(path.join(safeLogDir, `${assertSurfaceId(surfaceId)}.log`), {
    allowMissingLeaf: true,
  });
}

export function surfaceResourceId(surfaceId: string): string {
  return `surface:${surfaceId}`;
}

const SURFACE_STATE_FIELDS = ['version', 'surfaces'] as const;
const SURFACE_STATE_RECORD_FIELDS = [
  'id',
  'pid',
  'resourceId',
  'kind',
  'command',
  'args',
  'cwd',
  'logPath',
  'startedAt',
  'shutdownPolicy',
  'metadata',
] as const;
const SURFACE_STATE_RECORD_FIELD_SET = new Set<string>(SURFACE_STATE_RECORD_FIELDS);

function stateString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function parsePersistedSurfaceState(value: unknown): SurfaceRuntimeState {
  const root = parseSafeJsonObjectValue(value, 'surface runtime state');
  const allowedRootFields = new Set<string>(SURFACE_STATE_FIELDS);
  if (Object.keys(root).some((key) => !allowedRootFields.has(key))) {
    throw new Error('surface runtime state contains unknown fields');
  }
  if (root.version !== 1) throw new Error('surface runtime state version is invalid');
  const surfaces = parseSafeJsonObjectValue(root.surfaces, 'surface runtime state.surfaces');
  const normalized = Object.entries(surfaces).map(([surfaceKey, candidate]) => {
    const label = `surface runtime state.surfaces.${surfaceKey}`;
    const record = parseSafeJsonObjectValue(candidate, label);
    if (Object.keys(record).some((key) => !SURFACE_STATE_RECORD_FIELD_SET.has(key))) {
      throw new Error(`${label} contains unknown fields`);
    }
    const id = stateString(record, 'id', label);
    assertSurfaceId(id);
    if (surfaceKey !== id) throw new Error(`${label}.id does not match its map key`);
    const pid = record.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`${label}.pid must be a positive integer`);
    }
    const resourceId = stateString(record, 'resourceId', label);
    if (resourceId !== surfaceResourceId(id)) {
      throw new Error(`${label}.resourceId does not match its surface id`);
    }
    const kind = stateString(record, 'kind', label) as SurfaceRuntimeKind;
    if (!['gateway', 'ui', 'service'].includes(kind)) {
      throw new Error(`${label}.kind is invalid`);
    }
    const command = stateString(record, 'command', label);
    if (!Array.isArray(record.args)) {
      throw new Error(`${label}.args must be an array of strings`);
    }
    const args = record.args.map((arg, index) => {
      if (typeof arg !== 'string') {
        throw new Error(`${label}.args[${index}] must be a string`);
      }
      return arg;
    });
    const cwd = stateString(record, 'cwd', label);
    const logPath = stateString(record, 'logPath', label);
    if (path.resolve(cwd) !== path.resolve(pathResolver.rootDir())) {
      assertSafeRepositoryPath(cwd, { allowMissingLeaf: true });
    }
    assertSafeRepositoryPath(logPath, { allowMissingLeaf: true });
    const startedAt = stateString(record, 'startedAt', label);
    if (!Number.isFinite(Date.parse(startedAt))) {
      throw new Error(`${label}.startedAt must be a valid timestamp`);
    }
    const shutdownPolicy = stateString(record, 'shutdownPolicy', label) as RuntimeShutdownPolicy;
    if (!['manual', 'idle', 'detached'].includes(shutdownPolicy)) {
      throw new Error(`${label}.shutdownPolicy is invalid`);
    }
    const metadata =
      record.metadata === undefined
        ? undefined
        : parseSafeJsonObjectValue(record.metadata, `${label}.metadata`);
    return [
      surfaceKey,
      {
        id,
        pid,
        resourceId,
        kind,
        command,
        args,
        cwd,
        logPath,
        startedAt,
        shutdownPolicy,
        ...(metadata ? { metadata } : {}),
      } satisfies SurfaceRuntimeStateRecord,
    ];
  });
  return { version: 1, surfaces: Object.fromEntries(normalized) };
}

function readSurfaceManifestFile(filePath: string): SurfaceRuntimeManifest {
  let value: SurfaceRuntimeManifest;
  try {
    value = surfaceManifestCatalog(filePath).load();
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new Error(
      `Invalid surface manifest file "${filePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (value.surfaces.length !== 1) {
    throw new Error(`Surface manifest file "${filePath}" must contain exactly one surface.`);
  }
  return value;
}

function readSurfaceManifestDirectory(
  manifestDir = surfaceManifestDirectoryPath()
): SurfaceRuntimeManifest | null {
  if (!safeExistsSync(manifestDir)) return null;
  const surfaces = safeReaddir(manifestDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .flatMap((entry) => readSurfaceManifestFile(path.join(manifestDir, entry)).surfaces);
  if (!surfaces.length) return null;
  return { version: 1, surfaces };
}

export function loadSurfaceManifest(manifestPath = surfaceManifestPath()): SurfaceRuntimeManifest {
  const resolvedManifestPath = assertSafeRepositoryPath(pathResolver.resolve(manifestPath), {
    allowMissingLeaf: true,
  });
  if (
    resolvedManifestPath === surfaceManifestPath() &&
    safeExistsSync(surfaceManifestDirectoryPath())
  ) {
    const directoryManifest = readSurfaceManifestDirectory(surfaceManifestDirectoryPath());
    if (directoryManifest) return directoryManifest;
  }
  if (safeExistsSync(resolvedManifestPath)) {
    try {
      return surfaceManifestCatalog(resolvedManifestPath).load();
    } catch (error) {
      if (error instanceof SyntaxError) throw error;
      throw new Error(
        `Invalid surface manifest: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const directoryManifest = readSurfaceManifestDirectory(resolvedManifestPath);
  if (directoryManifest) return directoryManifest;
  throw new Error(`Surface manifest not found: ${resolvedManifestPath}`);
}

export function saveSurfaceManifest(
  manifest: SurfaceRuntimeManifest,
  manifestPath = surfaceManifestPath()
): void {
  const validate = ensureSurfaceManifestValidator();
  if (!validate(manifest)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid surface manifest for saving: ${errors}`);
  }
  const surfaces = [...manifest.surfaces].sort((left, right) => left.id.localeCompare(right.id));
  const resolvedManifestPath = assertSafeRepositoryPath(pathResolver.resolve(manifestPath), {
    allowMissingLeaf: true,
  });
  const writeDirectoryManifests = resolvedManifestPath === surfaceManifestPath();

  if (writeDirectoryManifests) {
    const manifestDir = surfaceManifestDirectoryPath();
    if (!safeExistsSync(manifestDir)) {
      safeMkdir(manifestDir, { recursive: true });
    }

    const expectedPaths = new Set<string>();
    for (const surface of surfaces) {
      const surfaceManifest = {
        version: 1 as const,
        surfaces: [surface],
      };
      const filePath = surfaceManifestFilePath(surface.id);
      expectedPaths.add(pathResolver.resolve(filePath));
      ensureParentDir(filePath);
      safeWriteFile(filePath, JSON.stringify(surfaceManifest, null, 2));
    }

    for (const entry of safeReaddir(manifestDir)) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(manifestDir, entry);
      if (expectedPaths.has(pathResolver.resolve(filePath))) continue;
      safeUnlinkSync(filePath);
    }
  }

  ensureParentDir(resolvedManifestPath);
  safeWriteFile(resolvedManifestPath, JSON.stringify({ version: 1, surfaces }, null, 2));
}

export function loadSurfaceState(statePath = surfaceStatePath()): SurfaceRuntimeState {
  const safeStatePath = assertSafeRepositoryPath(pathResolver.resolve(statePath), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(safeStatePath)) {
    return { version: 1, surfaces: {} };
  }
  return parsePersistedSurfaceState(surfaceStateCatalog(safeStatePath).load());
}

export function saveSurfaceState(state: SurfaceRuntimeState, statePath = surfaceStatePath()): void {
  const safeStatePath = assertSafeRepositoryPath(pathResolver.resolve(statePath), {
    allowMissingLeaf: true,
  });
  ensureParentDir(safeStatePath);
  const validated = parsePersistedSurfaceState(state);
  const canonical = surfaceStateCatalog(safeStatePath).validate(validated, safeStatePath);
  safeWriteFile(safeStatePath, JSON.stringify(canonical, null, 2));
}

export function resolveSurfaceCwd(definition: SurfaceRuntimeDefinition): string {
  return definition.cwd ? pathResolver.resolve(definition.cwd) : pathResolver.rootDir();
}

export function normalizeSurfaceDefinition(
  definition: SurfaceRuntimeDefinition
): SurfaceRuntimeDefinition {
  const normalized = {
    ...definition,
    args: definition.args || [],
    cwd: resolveSurfaceCwd(definition),
    shutdownPolicy: definition.shutdownPolicy || 'detached',
    startupMode: definition.startupMode || 'background',
    ownerType: definition.ownerType || 'surface-runtime-manifest',
    enabled: definition.enabled !== false,
  };
  validateSurfaceDefinition(normalized);
  return normalized;
}

/**
 * UI surfaces must declare a port — they always own an HTTP listener.
 * Gateways may run socket-mode (e.g. Slack Bolt) and need no local port.
 * Services may or may not bind a port; we don't require it.
 * Validation throws for the unambiguous failure case (UI without port) and
 * warns for missing healthPath where it would otherwise prevent reconcile
 * from probing already_healthy.
 */
function validateSurfaceDefinition(d: SurfaceRuntimeDefinition): void {
  if (!d.enabled) return;
  if (d.kind === 'ui' && (typeof d.port !== 'number' || d.port <= 0)) {
    throw new Error(
      `[SURFACE_MANIFEST] UI surface "${d.id}" has no valid port. ` +
        `Add "port": <number> to knowledge/product/governance/surfaces/${d.id}.json, or change kind to "service" if it has no listening socket.`
    );
  }
  if (typeof d.port === 'number' && d.port > 0 && !d.healthPath) {
    logger.warn(
      `[SURFACE_MANIFEST] Surface "${d.id}" declares port ${d.port} but no healthPath. ` +
        `Add "healthPath": "/..." for accurate already_healthy probing during reconcile.`
    );
  }
}

export async function probeSurfaceHealth(
  definition: SurfaceRuntimeDefinition
): Promise<SurfaceHealthStatus> {
  const normalized = normalizeSurfaceDefinition(definition);
  if (!normalized.port || !normalized.healthPath) {
    return { status: 'unknown', detail: 'no_port_or_health_path' };
  }

  const url = `http://127.0.0.1:${normalized.port}${normalized.healthPath}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok
      ? { status: 'healthy', detail: `http_${response.status}` }
      : { status: 'unhealthy', detail: `http_${response.status}` };
  } catch (error: any) {
    return {
      status: 'unhealthy',
      detail: error?.name === 'AbortError' ? 'timeout' : 'connect_failed',
    };
  }
}

export async function probeSurfacePort(
  port: number,
  host = '127.0.0.1'
): Promise<SurfacePortStatus> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: SurfacePortStatus) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(750);
    socket.once('connect', () => finish({ occupied: true, detail: 'open' }));
    socket.once('timeout', () => finish({ occupied: false, detail: 'timeout' }));
    socket.once('error', () => finish({ occupied: false, detail: 'closed' }));
    socket.connect(port, host);
  });
}
