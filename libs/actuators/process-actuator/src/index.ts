import {
  logger,
  createStandardYargs,
  safeReadFile,
  runtimeSupervisor,
  spawnManagedProcess,
  stopManagedProcess,
} from '@agent/core';
import type { RuntimeResourceKind, RuntimeShutdownPolicy } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ProcessAction {
  action: 'spawn' | 'stop' | 'list' | 'status';
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
  };
}

export async function handleAction(input: ProcessAction) {
  const { action, params } = input;

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
          cwd: params.cwd || process.cwd(),
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

    default:
      throw new Error(`Unsupported process action: ${action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = path.resolve(process.cwd(), argv.input as string);
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
