import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { createStandardYargs } from '@agent/core/cli-utils';
import { readJson } from '@agent/core/foundation';
import { assertSafeRepositoryPath } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { runtimeSupervisor } from '@agent/core/runtime-supervisor';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import { loadSurfaceManifest, loadSurfaceState } from '@agent/core/surface-runtime';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import { retry } from '@agent/core/async-utils';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import { parseProcessAction, type ProcessAction } from './process-action-input.js';

const PROCESS_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/process-actuator/manifest.json'
);
const DEFAULT_PROCESS_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

function resolveProcessPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: PROCESS_MANIFEST_PATH,
  defaults: DEFAULT_PROCESS_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

export async function handleAction(input: ProcessAction) {
  const { action, steps, context } = input;

  if (action === 'pipeline') {
    if (!steps || steps.length === 0) return { status: 'error', message: 'Empty pipeline steps' };
    if (steps.length > 1)
      throw new Error(
        'process-actuator pipeline dispatch supports only a single step; use the main pipeline runner for multi-step sequences'
      );
    const step = steps[0];
    if (
      typeof step !== 'object' ||
      step === null ||
      Array.isArray(step) ||
      typeof (step as { op?: unknown }).op !== 'string'
    ) {
      throw new Error('process-actuator pipeline step requires an action op');
    }
    const result = await handleAction(
      parseProcessAction({
        action: (step as { op: string }).op,
        params: (step as { params?: unknown }).params,
        context,
      })
    );
    return { ...result, context: (result as any).context || context };
  }

  ensureDefaultOpPreflight();
  const preflight = await runOpPreflight({
    op: `process:${action}`,
    params: input.params || {},
    context: context && typeof context === 'object' ? context : undefined,
    source: 'actuator',
  });
  if (preflight.decision !== 'allow') {
    throw new Error(
      `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation process:${action} was not admitted.`}`
    );
  }
  const params = preflight.input as ProcessAction['params'];

  switch (action) {
    case 'spawn': {
      if (
        !params.resourceId ||
        !params.command ||
        !params.kind ||
        !params.ownerId ||
        !params.ownerType
      ) {
        throw new Error('resourceId, command, kind, ownerId, and ownerType are required for spawn');
      }
      return await retry(async () => {
        const managed = spawnManagedProcess({
          resourceId: params.resourceId,
          kind: params.kind,
          ownerId: params.ownerId,
          ownerType: params.ownerType,
          command: params.command,
          args: params.args || [],
          shutdownPolicy: params.shutdownPolicy || 'manual',
          spawnOptions: {
            cwd: params.cwd
              ? resolveProcessPath(String(params.cwd), false)
              : pathResolver.rootDir(),
            env: { ...process.env, ...(params.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        });
        return {
          status: 'spawned',
          resourceId: managed.resourceId,
          pid: managed.child.pid,
        };
      }, buildRetryOptions());
    }

    case 'stop': {
      if (!params.resourceId) throw new Error('resourceId is required for stop');
      return await retry(async () => {
        const record = runtimeSupervisor.get(params.resourceId);
        stopManagedProcess(params.resourceId, null);
        return { status: 'stopped', resourceId: params.resourceId, pid: record?.pid };
      }, buildRetryOptions());
    }

    case 'status': {
      if (!params.resourceId) throw new Error('resourceId is required for status');
      return await retry(
        async () => ({ status: 'ok', resource: runtimeSupervisor.get(params.resourceId) || null }),
        buildRetryOptions()
      );
    }

    case 'list':
      return await retry(
        async () => ({ status: 'ok', resources: runtimeSupervisor.snapshot() }),
        buildRetryOptions()
      );

    case 'list-surfaces': {
      return await retry(async () => {
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
        return params.export_as
          ? { ...data, context: { ...context, [params.export_as]: results } }
          : data;
      }, buildRetryOptions());
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
  const argv = await createStandardYargs(process.argv)
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = resolveProcessPath(String(argv.input), false);
  const input = readJson<unknown>(inputPath);
  const result = await handleAction(parseProcessAction(input));
  console.log(JSON.stringify(result, null, 2));
};

if (
  isDirectEntry(import.meta.url, 'libs/actuators/process-actuator/src/process-actuator-helpers.ts')
) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
