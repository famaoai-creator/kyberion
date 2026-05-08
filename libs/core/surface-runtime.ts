import AjvModule, { type ValidateFunction } from 'ajv';
import * as path from 'node:path';
import * as net from 'node:net';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import type { RuntimeResourceKind, RuntimeShutdownPolicy } from './runtime-supervisor.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SURFACE_MANIFEST_SCHEMA_PATH = pathResolver.knowledge('public/schemas/runtime-surface-manifest.schema.json');

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
  if (!safeExistsSync(logPath)) return [];
  const content = safeReadFile(logPath, { encoding: 'utf8' }) as string;
  return content
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

const DEFAULT_MANIFEST_PATH = 'knowledge/public/governance/active-surfaces.json';
const STATE_PATH = pathResolver.shared('runtime/surfaces/state.json');
const LOG_DIR = pathResolver.shared('logs/surfaces');
let surfaceManifestValidateFn: ValidateFunction | null = null;

function ensureSurfaceManifestValidator(): ValidateFunction {
  if (surfaceManifestValidateFn) return surfaceManifestValidateFn;
  surfaceManifestValidateFn = compileSchemaFromPath(ajv, SURFACE_MANIFEST_SCHEMA_PATH);
  return surfaceManifestValidateFn;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

export function surfaceManifestPath(): string {
  return pathResolver.resolve(DEFAULT_MANIFEST_PATH);
}

export function surfaceStatePath(): string {
  return STATE_PATH;
}

export function surfaceLogPath(surfaceId: string): string {
  if (!safeExistsSync(LOG_DIR)) safeMkdir(LOG_DIR, { recursive: true });
  return path.join(LOG_DIR, `${surfaceId}.log`);
}

export function surfaceResourceId(surfaceId: string): string {
  return `surface:${surfaceId}`;
}

export function loadSurfaceManifest(manifestPath = surfaceManifestPath()): SurfaceRuntimeManifest {
  const value = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string) as SurfaceRuntimeManifest;
  const validate = ensureSurfaceManifestValidator();
  if (!validate(value)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid surface manifest: ${errors}`);
  }
  return value;
}

export function saveSurfaceManifest(manifest: SurfaceRuntimeManifest, manifestPath = surfaceManifestPath()): void {
  const validate = ensureSurfaceManifestValidator();
  if (!validate(manifest)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid surface manifest for saving: ${errors}`);
  }
  ensureParentDir(manifestPath);
  safeWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export function loadSurfaceState(statePath = surfaceStatePath()): SurfaceRuntimeState {
  if (!safeExistsSync(statePath)) {
    return { version: 1, surfaces: {} };
  }
  return JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string) as SurfaceRuntimeState;
}

export function saveSurfaceState(state: SurfaceRuntimeState, statePath = surfaceStatePath()): void {
  ensureParentDir(statePath);
  safeWriteFile(statePath, JSON.stringify(state, null, 2));
}

export function resolveSurfaceCwd(definition: SurfaceRuntimeDefinition): string {
  return definition.cwd ? pathResolver.resolve(definition.cwd) : pathResolver.rootDir();
}

export function normalizeSurfaceDefinition(definition: SurfaceRuntimeDefinition): SurfaceRuntimeDefinition {
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
      `Add "port": <number> to active-surfaces.json, or change kind to "service" if it has no listening socket.`,
    );
  }
  if (typeof d.port === 'number' && d.port > 0 && !d.healthPath) {
    console.warn(
      `[SURFACE_MANIFEST] Surface "${d.id}" declares port ${d.port} but no healthPath. ` +
      `Add "healthPath": "/..." for accurate already_healthy probing during reconcile.`,
    );
  }
}

export async function probeSurfaceHealth(definition: SurfaceRuntimeDefinition): Promise<SurfaceHealthStatus> {
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
    return { status: 'unhealthy', detail: error?.name === 'AbortError' ? 'timeout' : 'connect_failed' };
  }
}

export async function probeSurfacePort(port: number, host = '127.0.0.1'): Promise<SurfacePortStatus> {
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
