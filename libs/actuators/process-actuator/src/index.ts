import {
  logger,
  createStandardYargs,
  safeReadFile,
  pathResolver,
  runtimeSupervisor,
  spawnManagedProcess,
  stopManagedProcess,
  loadSurfaceManifest,
  loadSurfaceState,
} from '@agent/core';
import type { RuntimeResourceKind, RuntimeShutdownPolicy } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProcessAction {
  action: 'spawn' | 'stop' | 'list' | 'status' | 'list-surfaces' | 'pipeline';
  steps?: any[];
  context?: any;
  params: {
    resourceId?: string;
    ownerId?: string;
    ownerType?: string;
    kind?: RuntimeResourceKind;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    shutdownPolicy?: RuntimeShutdownPolicy;
    export_as?: string;
  };
}

export async function handleAction(input: ProcessAction) {
  const { action, params, steps, context } = input;

  // Pipeline dispatcher: single-step only — process-actuator does not orchestrate multi-step pipelines.
  if (action === 'pipeline') {
    if (!steps || steps.length === 0) return { status: 'error', message: 'Empty pipeline steps' };
    if (steps.length > 1) throw new Error('process-actuator pipeline dispatch supports only a single step; use the main pipeline runner for multi-step sequences');
    const step = steps[0];
    const result = await handleAction({ action: step.op as any, params: step.params, context });
    return { ...result, context: (result as any).context || context };
  }

  switch (action) {
    case 'spawn': {
      if (!params.resourceId || !params.command || !params.kind || !params.ownerId || !params.ownerType) {
        throw new Error('resourceId, command, kind, ownerId, and ownerType are required for spawn');
      }
      const managed = spawnManagedProcess({
        resourceId: params.resourceId,
        kind: params.kind,
        ownerId: params.ownerId,
        ownerType: params.ownerType,
        command: params.command,
        args: params.args || [],
        shutdownPolicy: params.shutdownPolicy || 'manual',
        spawnOptions: {
          cwd: params.cwd ? pathResolver.rootResolve(params.cwd) : pathResolver.rootDir(),
          env: { ...process.env, ...(params.env || {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      });
      return {
        status: 'spawned',
        resourceId: managed.resourceId,
        pid: managed.child.pid,
      };
    }

    case 'stop': {
      if (!params.resourceId) throw new Error('resourceId is required for stop');
      const record = runtimeSupervisor.get(params.resourceId);
      stopManagedProcess(params.resourceId, null);
      return { status: 'stopped', resourceId: params.resourceId, pid: record?.pid };
    }

    case 'status': {
      if (!params.resourceId) throw new Error('resourceId is required for status');
      return { status: 'ok', resource: runtimeSupervisor.get(params.resourceId) || null };
    }

    case 'list':
      return { status: 'ok', resources: runtimeSupervisor.snapshot() };

    case 'list-surfaces': {
      const manifest = loadSurfaceManifest();
      const state = loadSurfaceState();

      const results = manifest.surfaces.map((s) => {
        const record = state.surfaces[s.id];
        const running = record && isProcessRunning(record.pid);
        return {
          id: s.id,
          kind: s.kind,
          enabled: s.enabled !== false,
          running: !!running,
          port: s.port,
          url: s.port ? `http://localhost:${s.port}${s.healthPath || '/'}` : null,
          home_url: s.port ? `http://localhost:${s.port}/` : null,
        };
      });
      const data = { status: 'ok', surfaces: results };
      return params.export_as ? { ...data, context: { ...context, [params.export_as]: results } } : data;
    }


    default:
      throw new Error(`Unsupported process action: ${action}`);
  }
}

function isProcessRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = pathResolver.rootResolve(argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
