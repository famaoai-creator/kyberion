import * as path from 'node:path';
import {
  createStandardYargs,
  loadSurfaceManifest,
  readSurfaceLogTail,
  loadSurfaceState,
  logger,
  normalizeSurfaceDefinition,
  probeSurfacePort,
  pathResolver,
  probeSurfaceHealth,
  runtimeSupervisor,
  saveSurfaceState,
  safeExistsSync,
  safeOpenAppendFile,
  spawnManagedProcess,
  surfaceLogPath,
  surfaceManifestPath,
  surfaceResourceId,
  surfaceStatePath,
  validateServiceAuth,
} from '@agent/core';

type SurfaceAction = 'reconcile' | 'start' | 'stop' | 'status';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function registerRunningSurfaceFromState(record: ReturnType<typeof loadSurfaceState>['surfaces'][string]) {
  runtimeSupervisor.update(record.resourceId, {
    pid: record.pid,
    state: 'running',
    metadata: {
      ...record.metadata,
      command: record.command,
      args: record.args,
      logPath: record.logPath,
    },
    lastActiveAt: Date.now(),
  }) || runtimeSupervisor.register({
    resourceId: record.resourceId,
    kind: record.kind,
    ownerId: record.id,
    ownerType: 'surface-runtime-manifest',
    pid: record.pid,
    shutdownPolicy: record.shutdownPolicy,
    metadata: {
      ...record.metadata,
      command: record.command,
      args: record.args,
      logPath: record.logPath,
    },
    cleanup: () => {
      try {
        process.kill(record.pid, 'SIGTERM');
      } catch (_) {}
    },
  });
}

function stopByPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {}
}

export async function startSurfaceById(surfaceId: string, manifestPath: string) {
  const manifest = loadSurfaceManifest(manifestPath);
  const definition = manifest.surfaces.find((entry) => entry.id === surfaceId);
  if (!definition) {
    throw new Error(`Surface "${surfaceId}" not found in manifest ${manifestPath}`);
  }

  const normalized = normalizeSurfaceDefinition(definition);
  if (!normalized.enabled) {
    throw new Error(`Surface "${surfaceId}" is disabled in manifest ${manifestPath}`);
  }

  // --- AUTH VALIDATION ---
  const serviceId = (definition as any).service_id || surfaceId;
  const presetPath = (definition as any).preset_path;
  if (presetPath) {
    const authRes = await validateServiceAuth(serviceId, presetPath);
    if (!authRes.valid) {
      logger.error(`⚠️ [SURFACE] Auth validation failed for ${surfaceId}: ${authRes.reason}. Skipping start.`);
      return {
        status: 'skipped_auth_required',
        id: surfaceId,
        reason: authRes.reason
      };
    }
  }
  // ------------------------

  const state = loadSurfaceState();
  const existing = state.surfaces[surfaceId];
  if (existing && isRunning(existing.pid)) {
    registerRunningSurfaceFromState(existing);
    return {
      status: 'running',
      id: surfaceId,
      pid: existing.pid,
      resourceId: existing.resourceId,
      logPath: existing.logPath,
    };
  }

  const health = await probeSurfaceHealth(normalized);
  if (health.status === 'healthy') {
    return {
      status: 'already_healthy',
      id: surfaceId,
      detail: health.detail,
      port: normalized.port,
      healthPath: normalized.healthPath,
    };
  }

  if (normalized.port) {
    const portStatus = await probeSurfacePort(normalized.port);
    if (portStatus.occupied) {
      throw new Error(`Surface "${surfaceId}" port ${normalized.port} is already in use`);
    }
  }

  const cwd = normalized.cwd!;
  const logPath = surfaceLogPath(surfaceId);
  const out = safeOpenAppendFile(logPath);
  const managed = spawnManagedProcess({
    resourceId: surfaceResourceId(surfaceId),
    kind: normalized.kind,
    ownerId: surfaceId,
    ownerType: normalized.ownerType!,
    command: normalized.command,
    args: normalized.args,
    shutdownPolicy: normalized.shutdownPolicy,
    spawnOptions: {
      cwd,
      env: {
        ...process.env,
        ...(normalized.env || {}),
        AUTHORIZED_SCOPE: serviceId, // Inject scoped identity for TIBA
        SYSTEM_ROLE: surfaceId.replace(/-/g, '_'), // Inject role for secure-io (e.g., slack_bridge)
      },
      detached: normalized.shutdownPolicy === 'detached',
      stdio: ['ignore', out, out],
    },
    metadata: {
      manifestPath,
      startupMode: normalized.startupMode,
      port: normalized.port,
      healthPath: normalized.healthPath,
      cwd,
    },
  });

  if (normalized.shutdownPolicy === 'detached') {
    managed.child.unref();
  }

  state.surfaces[surfaceId] = {
    id: surfaceId,
    pid: managed.child.pid || -1,
    resourceId: surfaceResourceId(surfaceId),
    kind: normalized.kind,
    command: normalized.command,
    args: normalized.args || [],
    cwd,
    logPath,
    startedAt: new Date().toISOString(),
    shutdownPolicy: normalized.shutdownPolicy || 'detached',
    metadata: {
      manifestPath,
      startupMode: normalized.startupMode,
      port: normalized.port,
      healthPath: normalized.healthPath,
    },
  };
  saveSurfaceState(state);

  return {
    status: 'started',
    id: surfaceId,
    pid: managed.child.pid,
    resourceId: surfaceResourceId(surfaceId),
    logPath,
  };
}

function stopSurfaceById(surfaceId: string) {
  const state = loadSurfaceState();
  const record = state.surfaces[surfaceId];
  if (!record) {
    return { status: 'not_found', id: surfaceId };
  }

  stopByPid(record.pid);
  runtimeSupervisor.unregister(record.resourceId);
  delete state.surfaces[surfaceId];
  saveSurfaceState(state);
  return { status: 'stopped', id: surfaceId, pid: record.pid };
}

async function reconcileSurfaces(manifestPath: string, cleanup = false) {
  const manifest = loadSurfaceManifest(manifestPath);
  const state = loadSurfaceState();

  for (const [surfaceId, record] of Object.entries(state.surfaces)) {
    if (!isRunning(record.pid)) {
      runtimeSupervisor.unregister(record.resourceId);
      delete state.surfaces[surfaceId];
    } else {
      registerRunningSurfaceFromState(record);
    }
  }

  const results: Array<Record<string, unknown>> = [];
  for (const definition of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    if (!definition.enabled) continue;
    const existing = state.surfaces[definition.id];
    if (existing && isRunning(existing.pid)) {
      results.push({ id: definition.id, status: 'running', pid: existing.pid });
      continue;
    }
    const started = await startSurfaceById(definition.id, manifestPath);
    results.push(started);
  }

  if (cleanup) {
    const manifestIds = new Set(manifest.surfaces.map((entry) => entry.id));
    for (const surfaceId of Object.keys(state.surfaces)) {
      if (!manifestIds.has(surfaceId)) {
        stopSurfaceById(surfaceId);
        results.push({ id: surfaceId, status: 'stopped_removed' });
      }
    }
  }

  return {
    status: 'reconciled',
    manifestPath,
    statePath: surfaceStatePath(),
    results,
    runtime: runtimeSupervisor.snapshot(),
  };
}

async function statusSurfaces() {
  const state = loadSurfaceState();
  const manifest = loadSurfaceManifest();
  for (const [surfaceId, record] of Object.entries(state.surfaces)) {
    if (isRunning(record.pid)) {
      registerRunningSurfaceFromState(record);
    }
  }

  const health: Record<string, unknown> = {};
  const diagnostics: Record<string, unknown> = {};
  for (const definition of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    health[definition.id] = await probeSurfaceHealth(definition);
    const record = state.surfaces[definition.id];
    diagnostics[definition.id] = {
      lastKnownState: record
        ? {
            pid: record.pid,
            startedAt: record.startedAt,
            logPath: record.logPath,
            startupMode: record.metadata?.startupMode || definition.startupMode,
          }
        : null,
      recentLogTail: record?.logPath ? readSurfaceLogTail(record.logPath, 12) : [],
    };
  }
  return {
    status: 'ok',
    manifestPath: surfaceManifestPath(),
    statePath: surfaceStatePath(),
    surfaces: state.surfaces,
    health,
    diagnostics,
    runtime: runtimeSupervisor.snapshot(),
  };
}

async function reconcileHealth(manifestPath: string) {
  const manifest = loadSurfaceManifest(manifestPath);
  const restarted: string[] = [];

  for (const definition of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    const state = loadSurfaceState();
    const record = state.surfaces[definition.id];
    if (!record || !isRunning(record.pid)) continue;

    const health = await probeSurfaceHealth(definition);
    if (health.status === 'unhealthy') {
      stopSurfaceById(definition.id);
      await startSurfaceById(definition.id, manifestPath);
      restarted.push(definition.id);
    }
  }

  return restarted;
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('action', { type: 'string', choices: ['reconcile', 'start', 'stop', 'status'] as const, required: true })
    .option('surface', { type: 'string' })
    .option('manifest', { type: 'string', default: surfaceManifestPath() })
    .option('cleanup', { type: 'boolean', default: false })
    .parseSync();

  const action = argv.action as SurfaceAction;
  const manifestPath = path.isAbsolute(argv.manifest as string)
    ? (argv.manifest as string)
    : pathResolver.resolve(argv.manifest as string);

  let result: unknown;
  switch (action) {
    case 'reconcile':
      result = await reconcileSurfaces(manifestPath, Boolean(argv.cleanup));
      Object.assign(result as object, { restartedUnhealthy: await reconcileHealth(manifestPath) });
      break;
    case 'start':
      if (!argv.surface) throw new Error('--surface is required for start');
      result = await startSurfaceById(argv.surface as string, manifestPath);
      break;
    case 'stop':
      if (!argv.surface) throw new Error('--surface is required for stop');
      result = stopSurfaceById(argv.surface as string);
      break;
    case 'status':
      result = await statusSurfaces();
      break;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  console.log(JSON.stringify(result, null, 2));
};

const isMain = process.argv[1] && (
  process.argv[1].endsWith('surface_runtime.ts') || 
  process.argv[1].endsWith('surface_runtime.js') ||
  process.argv[1].endsWith('surface_runtime.mts')
);

if (isMain) {
  main().catch((err: any) => {
    logger.error(err.message);
    process.exit(1);
  });
}
