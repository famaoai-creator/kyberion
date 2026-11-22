import * as path from 'node:path';
import { buildExecutionEnv } from '@agent/core/authority';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import { pathResolver } from '@agent/core/path-resolver';
import { isolatedScopeEnvPath } from '@agent/core/scope-context';
import { safeExistsSync } from '@agent/core/secure-io';
import { COLLECTOR_NOT_STARTED_EXIT, CollectorNotStarted } from './continuous_collector_state.js';
import type { ContinuousProcessContainment } from './continuous_owner_platform.js';
import { runContinuousOwnerProcess } from './continuous_owner_process.js';

/** Interrupted work needs evidence before an automatic replay can be trusted. */
export class UncertainContinuousCollector extends Error {}

function collectorWorkerPath(root: string) {
  return path.join(root, 'dist/scripts/continuous/continuous_collector_worker.js');
}

export function assertCollectorWorkerAvailable(root: string): void {
  if (!safeExistsSync(collectorWorkerPath(root))) throw new CollectorNotStarted('worker_missing');
}

export async function runContinuousCollectorProcess(
  ref: string,
  charter: DotCharter,
  deadline: number,
  rootDir = pathResolver.rootDir(),
  run = runContinuousOwnerProcess,
  assertCurrent?: () => void,
  attemptId?: string,
  onSpawn?: (process: ContinuousProcessContainment) => void
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CollectorNotStarted('deadline_elapsed');
  if (!attemptId) throw new Error('Continuous collector attempt is required');
  const { scope } = charter;
  try {
    assertCurrent?.();
  } catch {
    throw new CollectorNotStarted('authorization_changed');
  }
  const abort = new AbortController();
  const monitor = assertCurrent
    ? setInterval(() => {
        try {
          assertCurrent();
        } catch {
          abort.abort();
        }
      }, 500)
    : undefined;
  const result = await Promise.resolve()
    .then(() =>
      run(process.execPath, [collectorWorkerPath(rootDir), charter.dot_id, ref, attemptId], {
        cwd: rootDir,
        env: {
          ...buildExecutionEnv(),
          KYBERION_SCOPE_ENV_PATH: isolatedScopeEnvPath(),
          KYBERION_TIER: scope.tier,
          KYBERION_TENANT: scope.tenant_slug ?? '',
          KYBERION_ORGANIZATION_ID: scope.organization_id ?? '',
          KYBERION_PROJECT_ID: scope.project_id ?? '',
          KYBERION_STANCE: '',
          KYBERION_CUSTOMER: '',
          MISSION_ID: '',
          KYBERION_TASK_ID: '',
          TASK_ID: '',
        },
        timeoutMs: remaining,
        maxOutputMB: 2,
        signal: abort.signal,
        onSpawn,
      })
    )
    .catch(() => {
      throw new UncertainContinuousCollector('Collector could not confirm a terminal receipt');
    })
    .finally(() => clearInterval(monitor));
  if (result.notSpawned) throw new CollectorNotStarted('spawn_rejected');
  if (result.error || result.status === null || result.status === 3)
    throw new UncertainContinuousCollector('Collector interrupted before a terminal receipt');
  if (result.status === COLLECTOR_NOT_STARTED_EXIT)
    throw new CollectorNotStarted('pipeline_preflight_failed');
  if (result.status !== 0) throw new Error('Continuous collector pipeline failed');
}
