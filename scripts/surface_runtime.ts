import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createStandardYargs,
  loadSurfaceManifest,
  saveSurfaceManifest,
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
  surfaceManifestDirectoryPath,
  surfaceManifestFilePath,
  surfaceManifestPath,
  surfaceResourceId,
  surfaceStatePath,
  validateServiceAuth,
  auditChain,
} from '@agent/core';
import type { SurfaceRuntimeDefinition, SurfaceRuntimeKind } from '@agent/core';

type SurfaceAction = 'reconcile' | 'start' | 'stop' | 'status' | 'list-units' | 'enable' | 'disable' | 'register' | 'unregister';

const execFileAsync = promisify(execFile);

async function describePortHolder(port: number): Promise<{ pid: number; cwd: string | null } | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']);
    const lines = stdout.split('\n');
    const pidLine = lines.find((l) => l.startsWith('p'));
    if (!pidLine) return null;
    const pid = Number(pidLine.slice(1));
    if (!Number.isFinite(pid) || pid <= 0) return null;
    let cwd: string | null = null;
    try {
      const { stdout: cwdOut } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
      const nLine = cwdOut.split('\n').find((l) => l.startsWith('n'));
      if (nLine) cwd = nLine.slice(1);
    } catch {
      // best-effort
    }
    return { pid, cwd };
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function registerRunningSurfaceFromState(record: any) {
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
      const offender = await describePortHolder(normalized.port);
      const ownCwd = pathResolver.rootDir();
      const foreignNote = offender && offender.cwd && offender.cwd !== ownCwd
        ? ` Holder appears to run from ${offender.cwd} (pid ${offender.pid}) — different from this repo at ${ownCwd}. Stop the foreign process or change ${surfaceManifestFilePath(surfaceId)}.`
        : offender
          ? ` Held by pid ${offender.pid}.`
          : '';
      throw new Error(`Surface "${surfaceId}" port ${normalized.port} is already in use.${foreignNote}`);
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
    try {
      const started = await startSurfaceById(definition.id, manifestPath);
      results.push(started);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  [SURFACE] Failed to start "${definition.id}": ${message}. Continuing with the next surface.`);
      results.push({ id: definition.id, status: 'failed', reason: message });
    }
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
    manifestDirectory: surfaceManifestDirectoryPath(),
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
    manifestDirectory: surfaceManifestDirectoryPath(),
    statePath: surfaceStatePath(),
    surfaces: state.surfaces,
    health,
    diagnostics,
    runtime: runtimeSupervisor.snapshot(),
  };
}

async function listUnits() {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  
  const results = await Promise.all(manifest.surfaces.map(async (d) => {
    const normalized = normalizeSurfaceDefinition(d);
    const record = state.surfaces[d.id];
    const running = record && isRunning(record.pid);
    const health = await probeSurfaceHealth(normalized);
    
    return {
      unit: d.id,
      kind: d.kind,
      enabled: d.enabled !== false ? 'enabled' : 'disabled',
      status: running ? 'running' : 'stopped',
      health: health.status,
      port: d.port || '-',
      pid: record?.pid || '-'
    };
  }));

  console.log('');
  const header = `${'UNIT'.padEnd(25)} ${'KIND'.padEnd(10)} ${'ENABLED'.padEnd(10)} ${'STATUS'.padEnd(10)} ${'HEALTH'.padEnd(10)} ${'PORT'.padEnd(6)} PID`;
  console.log(header);
  console.log('-'.repeat(header.length + 5));
  
  for (const r of results) {
    const statusColor = r.status === 'running' ? '🟢' : '⚪';
    const enabledColor = r.enabled === 'enabled' ? '✅' : '❌';
    console.log(
      `${r.unit.padEnd(25)} ${r.kind.padEnd(10)} ${enabledColor} ${r.enabled.padEnd(8)} ${statusColor} ${r.status.padEnd(8)} ${r.health.padEnd(10)} ${String(r.port).padEnd(6)} ${r.pid}`
    );
  }
  console.log('');
}

async function enableSurfaceById(surfaceId: string, manifestPath: string) {
  const manifest = loadSurfaceManifest(manifestPath);
  const definition = manifest.surfaces.find(s => s.id === surfaceId);
  if (!definition) throw new Error(`Surface "${surfaceId}" not found.`);
  
  if (definition.enabled === true) {
    logger.info(`Surface "${surfaceId}" is already enabled.`);
  } else {
    definition.enabled = true;
    saveSurfaceManifest(manifest, manifestPath);
    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'operator',
      action: 'surface.enable',
      operation: surfaceId,
      result: 'completed',
      metadata: { surfaceId, manifestPath }
    });
    logger.success(`✅ Enabled surface "${surfaceId}".`);
  }
  
  return startSurfaceById(surfaceId, manifestPath);
}

async function disableSurfaceById(surfaceId: string, manifestPath: string) {
  const manifest = loadSurfaceManifest(manifestPath);
  const definition = manifest.surfaces.find(s => s.id === surfaceId);
  if (!definition) throw new Error(`Surface "${surfaceId}" not found.`);
  
  if (definition.enabled === false) {
    logger.info(`Surface "${surfaceId}" is already disabled.`);
  } else {
    definition.enabled = false;
    saveSurfaceManifest(manifest, manifestPath);
    auditChain.record({
      agentId: process.env.KYBERION_PERSONA || 'operator',
      action: 'surface.disable',
      operation: surfaceId,
      result: 'completed',
      metadata: { surfaceId, manifestPath }
    });
    logger.success(`✅ Disabled surface "${surfaceId}".`);
  }
  
  return stopSurfaceById(surfaceId);
}

async function registerSurface(params: {
  id: string,
  kind: SurfaceRuntimeKind,
  command: string,
  args?: string[],
  port?: number,
  description?: string,
  manifestPath: string
}) {
  const manifest = loadSurfaceManifest(params.manifestPath);
  if (manifest.surfaces.some(s => s.id === params.id)) {
    throw new Error(`Surface "${params.id}" is already registered.`);
  }
  
  const newSurface: SurfaceRuntimeDefinition = {
    id: params.id,
    kind: params.kind,
    description: params.description || `Surface ${params.id}`,
    command: params.command,
    args: params.args || [],
    port: params.port,
    enabled: true,
    startupMode: params.kind === 'ui' ? 'workspace-app' : 'background',
    shutdownPolicy: 'detached',
    ownerType: 'surface-runtime-manifest'
  };
  
  manifest.surfaces.push(newSurface);
  saveSurfaceManifest(manifest, params.manifestPath);
  
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
    action: 'surface.register',
    operation: params.id,
    result: 'completed',
    metadata: { ...newSurface, manifestPath: params.manifestPath }
  });
  
  logger.success(`✅ Registered new surface "${params.id}".`);
  return reconcileSurfaces(params.manifestPath);
}

async function unregisterSurfaceById(surfaceId: string, manifestPath: string) {
  const manifest = loadSurfaceManifest(manifestPath);
  const index = manifest.surfaces.findIndex(s => s.id === surfaceId);
  if (index === -1) throw new Error(`Surface "${surfaceId}" not found.`);
  
  const [removed] = manifest.surfaces.splice(index, 1);
  saveSurfaceManifest(manifest, manifestPath);
  
  await stopSurfaceById(surfaceId);

  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
    action: 'surface.unregister',
    operation: surfaceId,
    result: 'completed',
    metadata: { surfaceId, removed, manifestPath }
  });
  
  logger.success(`✅ Unregistered surface "${surfaceId}".`);
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
    .option('action', { type: 'string', choices: ['reconcile', 'start', 'stop', 'status', 'list-units', 'enable', 'disable', 'register', 'unregister'] as const, required: true })
    .option('surface', { type: 'string' })
    .option('manifest', { type: 'string', default: surfaceManifestPath() })
    .option('cleanup', { type: 'boolean', default: false })
    .option('kind', { type: 'string', choices: ['ui', 'service', 'gateway'] })
    .option('command', { type: 'string' })
    .option('args', { type: 'string' })
    .option('port', { type: 'number' })
    .option('description', { type: 'string' })
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
    case 'list-units':
      await listUnits();
      break;
    case 'enable':
      if (!argv.surface) throw new Error('--surface is required for enable');
      result = await enableSurfaceById(argv.surface as string, manifestPath);
      break;
    case 'disable':
      if (!argv.surface) throw new Error('--surface is required for disable');
      result = await disableSurfaceById(argv.surface as string, manifestPath);
      break;
    case 'register':
      if (!argv.surface || !argv.kind || !argv.command) {
        throw new Error('--surface, --kind, and --command are required for register');
      }
      result = await registerSurface({
        id: argv.surface as string,
        kind: argv.kind as SurfaceRuntimeKind,
        command: argv.command as string,
        args: argv.args ? (() => { try { return JSON.parse(argv.args as string); } catch { return (argv.args as string).split(' '); } })() : [],
        port: argv.port as number,
        description: argv.description as string,
        manifestPath
      });
      break;
    case 'unregister':
      if (!argv.surface) throw new Error('--surface is required for unregister');
      result = await unregisterSurfaceById(argv.surface as string, manifestPath);
      break;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  if (result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
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
