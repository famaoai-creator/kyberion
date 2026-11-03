import { isDirectEntry } from '@agent/core/direct-entry';
import {
  createStandardYargs,
  currentProcessArgv,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { parseSafeJsonObjectValue, readJson } from '@agent/core/foundation';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import * as pathResolver from '@agent/core/path-resolver';
import { runtimeSupervisor } from '@agent/core/tool/runtime-supervisor';
import { spawnManagedProcess, stopManagedProcess } from '@agent/core/managed-process';
import {
  isRecordedProcessAlive,
  processStartMarker,
} from '@agent/core/workforce/workspace-process-identity';
import { stripAuthorityEnvOverrides } from '@agent/core/authority';
import { loadSurfaceManifest, loadSurfaceState } from '@agent/core/surface/surface-runtime';

import { retry, getRetryDefaults } from '@agent/core/async-utils';
import { ensureDefaultOpPreflight } from '@agent/core/pipeline/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/pipeline/op-preflight';
import { defineActuatorPipelineBase } from '@agent/core/actuator/actuator-sdk';
import { parseProcessAction, type ProcessAction } from './process-action-input.js';

const PROCESS_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/process-actuator/manifest.json'
);
const DEFAULT_PROCESS_RETRY = getRetryDefaults('process');

function resolveProcessPath(ref: string, allowMissingLeaf = true): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(ref), { allowMissingLeaf });
}

function isExistingRegularFile(filePath: string): boolean {
  if (!safeExistsSync(filePath)) return false;
  try {
    return safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

export function readProcessJson(filePath: string, label: string): unknown {
  if (!isExistingRegularFile(filePath)) {
    throw new Error(`${label} must be an existing regular file: ${filePath}`);
  }
  return readJson(filePath);
}

export function readProcessJsonObject(filePath: string, label: string): Record<string, unknown> {
  return parseSafeJsonObjectValue(readProcessJson(filePath, label), label);
}

const { buildRetryOptions: buildRetryOptions } = defineActuatorPipelineBase({
  manifestPath: PROCESS_MANIFEST_PATH,
  retryDefaults: DEFAULT_PROCESS_RETRY,
  retryFallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
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
        throw new Error(
          '[PROCESS_INVALID_REQUEST] resourceId, command, kind, ownerId, and ownerType are required for spawn'
        );
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
            // Caller-supplied env may not set execution authority (DR-01).
            env: { ...process.env, ...stripAuthorityEnvOverrides(params.env) },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        });
        // 'spawn'/'error' settle on the next tick; report the real outcome
        // rather than claiming 'spawned' for a process that never started.
        const spawnError = await new Promise<Error | null>((resolve) => {
          managed.child.once('error', resolve);
          managed.child.once('spawn', () => resolve(null));
        });
        if (spawnError || managed.child.pid === undefined) {
          return {
            status: 'spawn_failed',
            resourceId: params.resourceId,
            reason: spawnError?.message || 'process did not start',
          };
        }
        return {
          status: 'spawned',
          resourceId: managed.resourceId,
          pid: managed.child.pid,
          pidStartMarker: processStartMarker(managed.child.pid),
        };
      }, buildRetryOptions());
    }

    case 'stop': {
      if (!params.resourceId)
        throw new Error('[PROCESS_INVALID_REQUEST] resourceId is required for stop');
      return await retry(async () => {
        const record = runtimeSupervisor.get(params.resourceId);
        if (!record) {
          // A valid selection the supervisor cannot resolve: report it as
          // unknown rather than claiming a stop that never happened.
          return {
            status: 'not_found',
            resourceId: params.resourceId,
            reason: 'resource_not_registered',
            next_step:
              'process:list shows registered resources; a resource is absent after its owning process exits',
          };
        }
        const gone =
          record.state === 'exited' ||
          (record.pid !== undefined && !isRecordedProcessAlive(record.pid, record.pidStartMarker));
        // Route through the record's own cleanup so the registered process is
        // actually terminated; a failed cleanup retains ownership for retry.
        const outcome = await runtimeSupervisor.cleanup(params.resourceId, 'process:stop');
        if (outcome === 'retained') {
          return {
            status: 'cleanup_failed',
            resourceId: params.resourceId,
            reason: record.lastCleanupError?.error ?? 'cleanup_failed',
            next_step:
              'the record is still owned; retry process:stop or inspect with process:status',
          };
        }
        stopManagedProcess(params.resourceId, null);
        if (gone) {
          return {
            status: 'already_exited',
            resourceId: params.resourceId,
            pid: record.pid,
            reason: record.pidStartMarker ? 'pid_recycled_or_exited' : 'not_running',
          };
        }
        return { status: 'stopped', resourceId: params.resourceId, pid: record.pid };
      }, buildRetryOptions());
    }

    case 'status': {
      if (!params.resourceId)
        throw new Error('[PROCESS_INVALID_REQUEST] resourceId is required for status');
      return await retry(async () => {
        const record = runtimeSupervisor.get(params.resourceId) || null;
        return {
          status: 'ok',
          resource: record
            ? {
                ...record,
                ...(record.pid !== undefined
                  ? {
                      alive: isRecordedProcessAlive(record.pid, record.pidStartMarker),
                      identity: record.pidStartMarker ? 'pid+start_marker' : 'pid_only',
                    }
                  : {}),
              }
            : null,
        };
      }, buildRetryOptions());
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
          const running = record && isRecordedProcessAlive(record.pid, record.pidStartMarker);
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

const main = async () => {
  const argv = await createStandardYargs(currentProcessArgv())
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = resolveProcessPath(String(argv.input), false);
  const input = readProcessJson(inputPath, 'process action input');
  const result = await handleAction(parseProcessAction(input));
  // eslint-disable-next-line no-console -- CLI entry: stdout carries this command's JSON result
  console.log(JSON.stringify(result, null, 2));
};

if (
  isDirectEntry(import.meta.url, 'libs/actuators/process-actuator/src/process-actuator-helpers.ts')
) {
  void runActuatorCliEntryPoint(main, 'process-actuator');
}
