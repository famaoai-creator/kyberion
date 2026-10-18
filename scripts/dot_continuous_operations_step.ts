/** Scoped continuous operations on the existing resident-dot sweep. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { dotBudgetThrottle } from '@agent/core/dot/dot-budget';
import { dotStatePath } from '@agent/core/dot/dot-state-paths';
import {
  parseContinuousOperationsConfig,
  type ContinuousOperationsConfig,
} from '@agent/core/organization/continuous-operations-policy';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeReadFileSnapshot,
  safeReaddir,
  safeRealpath,
  safeWriteFile,
} from '@agent/core/secure-io';
import { withLock } from '@agent/core/lock-utils';
import { createLogger } from '@agent/core/logger';
import type { DotSupervisorStep } from './dot_supervisor_extensions.js';

const logger = createLogger('dot-continuous-operations');
const CONFIG_DIR = 'knowledge/product/governance/continuous-operations';
export interface ContinuousCadenceConfig {
  ref: string;
  config: ContinuousOperationsConfig;
}
export interface DotContinuousOperationsDeps {
  rootDir?: string;
  configs?: () => ContinuousCadenceConfig[];
  runAs?: <T>(charter: DotCharter, callback: () => Promise<T>) => Promise<T>;
  budgetHard?: (charter: DotCharter) => boolean;
  runCycle?: (ref: string, options: { apply: true; now: Date }) => Promise<unknown>;
  owner?: (charter: DotCharter, options: { now: Date }) => Promise<unknown>;
  readState?: (file: string) => unknown;
  writeState?: (file: string, value: unknown) => void;
  lock?: <T>(key: string, callback: () => Promise<T>) => Promise<T>;
}

function readJson(file: string): unknown {
  return parseSafeJsonInput(
    safeReadFileSnapshot(file, 1_048_576).toString('utf8'),
    'continuous cadence'
  );
}

export function discoverContinuousCadenceConfigs(
  root: string,
  onError?: (ref: string, error: unknown) => void
): ContinuousCadenceConfig[] {
  const directory = path.join(root, CONFIG_DIR);
  if (!safeExistsSync(directory)) return [];
  if (safeRealpath(directory) !== path.join(safeRealpath(root), CONFIG_DIR))
    throw new Error('Continuous configuration directory must not traverse symlinks');
  const names = safeReaddir(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (names.length > 1000) throw new Error('Too many continuous cadence configurations');
  return names.flatMap((name) => {
    const file = path.join(directory, name);
    try {
      if (safeRealpath(file) !== file)
        throw new Error('Continuous configuration must not traverse symlinks');
      return [
        {
          ref: `${CONFIG_DIR}/${name}`,
          config: parseContinuousOperationsConfig(readJson(file)),
        },
      ];
    } catch (error) {
      if (!onError) throw error;
      onError(`${CONFIG_DIR}/${name}`, error);
      return [];
    }
  });
}

function matches(charter: DotCharter, config: ContinuousOperationsConfig): boolean {
  return (
    charter.status === 'active' &&
    charter.dot_id === config.dot_id &&
    charter.scope.tier === config.scope.tier &&
    charter.scope.tenant_slug === config.scope.tenant_slug &&
    charter.scope.organization_id === config.scope.organization_id &&
    charter.scope.project_id === config.scope.project_id
  );
}

function stateFile(root: string, charter: DotCharter, config: ContinuousOperationsConfig): string {
  const identity = createHash('sha256')
    .update(JSON.stringify({ loop: config.loop_id, scope: config.scope, dot: config.dot_id }))
    .digest('hex');
  return path.join(root, dotStatePath(charter, `continuous-cadence-${identity}.json`));
}

function lastRun(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid continuous cadence state');
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    Object.keys(record).some((key) => !['version', 'last_run_at'].includes(key)) ||
    typeof record.last_run_at !== 'string'
  )
    throw new Error('Invalid continuous cadence state');
  const ms = Date.parse(record.last_run_at);
  if (!Number.isFinite(ms)) throw new Error('Invalid continuous cadence timestamp');
  return ms;
}

export async function runDotContinuousOperationsStep(
  now: Date,
  active: LoadedDotCharter[],
  deps: DotContinuousOperationsDeps = {}
): Promise<void> {
  const root = deps.rootDir ?? pathResolver.rootDir();
  const failures: string[] = [];
  const discoveryError = (ref: string, error: unknown): void => {
    failures.push(ref);
    logger.warn(
      `continuous configuration failed — ${error instanceof Error ? error.message : String(error)} | next: repair reviewed configuration | evidence: ${ref}`
    );
  };
  let configs: ContinuousCadenceConfig[] = [];
  try {
    configs = deps.configs
      ? deps.configs()
      : discoverContinuousCadenceConfigs(root, discoveryError);
  } catch (error) {
    discoveryError(CONFIG_DIR, error);
  }
  const cycle =
    deps.runCycle ??
    (async (ref, options) => {
      await import('./pipeline-execution-part-results.js');
      return (
        await import('./organization_continuous_operations.js')
      ).runContinuousOperationsCycleFromRef(ref, options);
    });
  const owner =
    deps.owner ??
    (async (charter, options) =>
      (await import('./organization_continuous_operations.js')).runContinuousManagedOwner(
        charter,
        options
      ));
  for (const { charter } of active) {
    if (charter.status !== 'active') continue;
    try {
      if (
        (
          deps.budgetHard ??
          ((c) => dotBudgetThrottle(c, { rootDir: root, now: () => now }).throttle === 'hard')
        )(charter)
      )
        continue;
      await (deps.runAs ?? runAsDotCharter)(charter, async () => {
        for (const { ref, config } of configs) {
          if (!config.enabled || !config.schedule || !matches(charter, config)) continue;
          try {
            await (deps.lock ?? ((key, callback) => withLock(key, callback, 1000)))(
              `continuous-cadence-${charter.dot_id}-${config.loop_id}`,
              async () => {
                const file = stateFile(root, charter, config);
                const stored = deps.readState
                  ? deps.readState(file)
                  : safeExistsSync(file)
                    ? readJson(file)
                    : undefined;
                const prior = stored === undefined ? undefined : lastRun(stored);
                // Future checkpoints fail closed until their clock catches up.
                if (
                  prior !== undefined &&
                  now.getTime() - prior < config.schedule!.every_seconds * 1000
                )
                  return;
                const value = { version: 1, last_run_at: now.toISOString() };
                if (deps.writeState) deps.writeState(file, value);
                else {
                  let existing = path.dirname(file);
                  while (!safeExistsSync(existing)) existing = path.dirname(existing);
                  if (
                    safeRealpath(existing) !==
                    path.resolve(safeRealpath(root), path.relative(root, existing))
                  )
                    throw new Error('Continuous cadence state must not traverse symlinks');
                  safeWriteFile(file, `${JSON.stringify(value)}\n`);
                }
                await cycle(ref, { apply: true, now });
              }
            );
          } catch (error) {
            failures.push(`${charter.dot_id}/${config.loop_id}`);
            logger.warn(
              `continuous cadence failed — ${error instanceof Error ? error.message : String(error)} | next: inspect configuration and cadence checkpoint | evidence: ${ref}`
            );
          }
        }
        // Pending work survives source recovery, disabled loops and quiet periods.
        await owner(charter, { now });
      });
    } catch (error) {
      failures.push(charter.dot_id);
      logger.warn(
        `continuous owner failed — ${error instanceof Error ? error.message : String(error)} | next: inspect managed work and authority | evidence: dot ${charter.dot_id}`
      );
    }
  }
  if (failures.length) throw new Error(`Continuous operations failed for ${failures.join(', ')}`);
}

export const DOT_CONTINUOUS_OPERATIONS_SUPERVISOR_STEP: DotSupervisorStep = {
  id: 'dot-continuous-operations',
  run: runDotContinuousOperationsStep,
};
