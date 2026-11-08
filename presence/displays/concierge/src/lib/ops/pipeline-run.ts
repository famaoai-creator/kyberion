import path from 'node:path';

import { spawnManagedProcess } from '@agent/core/managed-process';
import { pathResolver, toRepoRelative } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { serverChildEnv } from '../server-child-env';

/**
 * Detached governed pipeline runs for Concierge.
 *
 * runSteps is deliberately never called in-process (terminal-hud made the same
 * call for the same reason): a pipeline must not block or crash the Next
 * server. The child is bounded by SYSTEM_ROLE=concierge via serverChildEnv,
 * registered with the runtime supervisor, and left running (detached) when the
 * request returns — the run journal under the repo records its progress.
 */

export const CONCIERGE_RUN_OWNER_ID = 'concierge-ops';

const RUN_PIPELINE_ENTRY = 'dist/scripts/run_pipeline.js';

export class PipelineRunError extends Error {}

export function resolveRunnablePipelineFile(rawPath: string): string {
  const normalized = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new PipelineRunError('pipeline path must be repo-relative');
  }
  if (!normalized.startsWith('pipelines/') || !normalized.endsWith('.json')) {
    throw new PipelineRunError('pipeline must be a JSON file under pipelines/');
  }
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(normalized), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(absolute) || !safeLstat(absolute).isFile()) {
    throw new PipelineRunError(`pipeline file not found: ${normalized}`);
  }
  return absolute;
}

export interface PipelineRunDispatch {
  resourceId: string;
  pipelinePath: string;
}

export function dispatchPipelineRun(input: {
  pipelinePath: string;
  context?: Record<string, unknown>;
  label?: string;
}): PipelineRunDispatch {
  const pipelineFile = resolveRunnablePipelineFile(input.pipelinePath);
  const relative = toRepoRelative(pipelineFile);
  const args = [pathResolver.rootResolve(RUN_PIPELINE_ENTRY), '--input', pipelineFile, '--quiet'];
  if (input.context && Object.keys(input.context).length > 0) {
    args.push('--context', JSON.stringify(input.context));
  }
  const resourceId = `concierge-pipeline-run-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  spawnManagedProcess({
    resourceId,
    kind: 'service',
    ownerId: CONCIERGE_RUN_OWNER_ID,
    ownerType: 'operator_surface',
    command: process.execPath,
    args,
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      stdio: 'ignore',
      detached: true,
      env: serverChildEnv() as NodeJS.ProcessEnv,
    },
    shutdownPolicy: 'detached',
    metadata: {
      pipeline_path: relative,
      ...(input.label ? { label: input.label } : {}),
    },
  });
  return { resourceId, pipelinePath: relative };
}
