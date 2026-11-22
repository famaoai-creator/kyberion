/** Scoped continuous operations on the existing resident-dot sweep. */
import * as path from 'node:path';
import type { DotCharter, LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { dotBudgetThrottle } from '@agent/core/dot/dot-budget';
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
import { withLock } from '@agent/core/foundation/lock-utils';
import { reportDotStepFailure, DotSupervisorStepCircuit } from '@agent/core/dot/dot-step-circuit';
import { createLogger } from '@agent/core/logger';
import { CONTINUOUS_MANAGED_WORK_PIPELINE } from '@agent/core/organization/continuous-work-plan';
import type { ContinuousOperationsReport } from '@agent/core/organization/continuous-operations';
import type { ContinuousCycleOptions } from '../continuous/continuous_operations_cycle.js';
import type { DotSupervisorStep } from './dot_supervisor_extensions.js';
import {
  matches,
  readCheckpoint,
  scheduledAfter,
  stateFile,
  type CadenceCheckpoint,
} from '../continuous/continuous_operations_cadence.js';

const logger = createLogger('dot-continuous-operations');
const continuousCadenceCircuit = new DotSupervisorStepCircuit('dot-continuous-cadence');
const continuousAdmissionCircuit = new DotSupervisorStepCircuit('dot-continuous-admission');
const continuousObservationCircuit = new DotSupervisorStepCircuit('dot-continuous-observation');
const continuousOwnerCircuit = new DotSupervisorStepCircuit('dot-continuous-owner');
const CONFIG_DIR = 'knowledge/product/governance/continuous-operations';
export interface ContinuousCadenceConfig {
  ref: string;
  config: ContinuousOperationsConfig;
}
export interface DotContinuousOperationsDeps {
  phase?: 'observe' | 'advance';
  rootDir?: string;
  configs?: () => ContinuousCadenceConfig[];
  runAs?: <T>(charter: DotCharter, callback: () => Promise<T>) => Promise<T>;
  budgetHard?: (charter: DotCharter) => boolean;
  runCycle?: (
    ref: string,
    options: ContinuousCycleOptions & { apply: true; now: Date }
  ) => Promise<
    | (Pick<ContinuousOperationsReport, 'inventory'> & {
        admission_held?: boolean;
        withheld_sources?: string[];
      })
    | void
  >;
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

function persistCheckpoint(root: string, file: string, value: CadenceCheckpoint): void {
  let existing = path.dirname(file);
  while (!safeExistsSync(existing)) existing = path.dirname(existing);
  if (safeRealpath(existing) !== path.resolve(safeRealpath(root), path.relative(root, existing)))
    throw new Error('Continuous cadence state must not traverse symlinks');
  safeWriteFile(file, `${JSON.stringify(value)}\n`);
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
      : deps.phase === 'advance'
        ? []
        : discoverContinuousCadenceConfigs(root, discoveryError);
  } catch (error) {
    discoveryError(CONFIG_DIR, error);
  }
  const cycle =
    deps.runCycle ??
    (async (ref, options) => {
      await import('../pipeline/pipeline-execution-part-results.js');
      return (
        await import('../organization/organization_continuous_operations.js')
      ).runContinuousOperationsCycleFromRef(ref, options);
    });
  const owner =
    deps.owner ??
    (async (charter, options) =>
      (
        await import('../organization/organization_continuous_operations.js')
      ).runContinuousManagedOwner(charter, options));
  for (const { charter } of active) {
    if (charter.status !== 'active') continue;
    if (deps.phase === 'observe' && !continuousObservationCircuit.admits(charter.dot_id)) continue;
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
          const key = `${charter.dot_id}/${config.loop_id}`;
          if (!continuousCadenceCircuit.admits(key)) continue;
          try {
            await (deps.lock ?? ((key, callback) => withLock(key, callback, 1000)))(
              `continuous-cadence-${charter.dot_id}-${config.loop_id}`,
              async () => {
                const file = stateFile(root, charter, config);
                const prior = readCheckpoint(file, deps.readState);
                // Future checkpoints fail closed until their clock catches up.
                if (prior && now.getTime() < scheduledAfter(config.schedule!, prior)) return;
                const write =
                  deps.writeState ??
                  ((key: string, value: CadenceCheckpoint) => persistCheckpoint(root, key, value));
                const value: CadenceCheckpoint = {
                  ...prior,
                  version: 1,
                  last_run_at: now.toISOString(),
                };
                write(file, value);
                const report = await cycle(ref, {
                  apply: true,
                  now,
                  holdAdmission: !continuousAdmissionCircuit.admits(key),
                  holdCollector: prior?.collector_held,
                });
                const count =
                  report && !report.admission_held
                    ? report.inventory.filter((entry) => entry.disposition === 'error').length
                    : undefined;
                const observed = !report
                  ? value
                  : {
                      ...value,
                      last_observation_at: value.last_run_at,
                      last_withheld_sources: report.withheld_sources ?? [],
                      ...(report.admission_held
                        ? { last_admission_held: true }
                        : { last_admission_error_count: count }),
                    };
                if (!report || !report.admission_held) delete observed.last_admission_held;
                continuousCadenceCircuit.reportSuccess(key);
                if (count) {
                  write(file, observed);
                  failures.push(key);
                  reportDotStepFailure(
                    continuousAdmissionCircuit,
                    key,
                    charter,
                    new Error('Continuous cycle completed with admission errors'),
                    {
                      what: 'continuous admission failed',
                      next: 'inspect rule dispositions and admission authority',
                      evidence: ref,
                      log: (line) => logger.warn(line),
                    }
                  );
                  return;
                }
                if (report && report.admission_held) {
                  write(file, observed);
                  return;
                }
                write(
                  file,
                  report && report.withheld_sources?.length
                    ? observed
                    : { ...observed, last_success_at: value.last_run_at }
                );
                continuousAdmissionCircuit.reportSuccess(key);
              }
            );
          } catch (error) {
            failures.push(`${charter.dot_id}/${config.loop_id}`);
            reportDotStepFailure(
              continuousCadenceCircuit,
              `${charter.dot_id}/${config.loop_id}`,
              charter,
              error,
              {
                what: 'continuous cadence failed',
                next: 'inspect configuration and cadence checkpoint',
                evidence: ref,
                log: (line) => logger.warn(line),
              }
            );
          }
        }
        // Pending work survives source recovery, disabled loops and quiet periods.
        // The managed owner's circuit must not suppress independent observation cycles.
        if (deps.phase !== 'observe' && continuousOwnerCircuit.admits(charter.dot_id)) {
          await owner(charter, { now });
          continuousOwnerCircuit.reportSuccess(charter.dot_id);
        }
      });
      if (deps.phase === 'observe') continuousObservationCircuit.reportSuccess(charter.dot_id);
    } catch (error) {
      failures.push(charter.dot_id);
      const observing = deps.phase === 'observe';
      reportDotStepFailure(
        observing ? continuousObservationCircuit : continuousOwnerCircuit,
        charter.dot_id,
        charter,
        error,
        {
          what: observing ? 'continuous observation setup failed' : 'continuous owner failed',
          next: observing
            ? 'inspect observation scope and budget'
            : 'inspect managed work and authority',
          evidence: `dot ${charter.dot_id}`,
          log: (line) => logger.warn(line),
        }
      );
    }
  }
  if (failures.length) throw new Error(`Continuous operations failed for ${failures.join(', ')}`);
}

type Phase = NonNullable<DotContinuousOperationsDeps['phase']>;
type Flight = { deadline: number; overdue: boolean };

/** Separate bounded lanes let the resident sweep advance work while collectors are busy. */
export class ContinuousOperationLane {
  private readonly flights = new Map<string, Flight>();
  private cursor?: string;

  constructor(
    private readonly phase: Phase,
    private readonly capacity = 2
  ) {}

  get inFlight(): boolean {
    return this.flights.size > 0;
  }

  submit(active: LoadedDotCharter[], run: (charter: LoadedDotCharter) => Promise<void>): void {
    const now = Date.now();
    for (const flight of this.flights.values()) {
      if (flight.overdue || now < flight.deadline) continue;
      flight.overdue = true;
      logger.warn(
        `continuous ${this.phase} exceeded its time budget — waiting for in-flight work to settle | next: inspect the continuous runtime | evidence: continuous supervisor lane`
      );
    }
    const candidates = [...active].sort((a, b) => a.charter.dot_id.localeCompare(b.charter.dot_id));
    const next = candidates.findIndex(
      ({ charter }) => charter.dot_id.localeCompare(this.cursor ?? '') > 0
    );
    const ordered =
      next > 0 ? [...candidates.slice(next), ...candidates.slice(0, next)] : candidates;
    for (const loaded of ordered) {
      if (this.flights.size >= this.capacity) break;
      const { charter } = loaded;
      if (this.flights.has(charter.dot_id)) continue;
      this.cursor = charter.dot_id;
      this.flights.set(charter.dot_id, {
        deadline: now + (charter.goal?.budget?.wall_clock_ms_per_wake ?? 60_000),
        overdue: false,
      });
      void Promise.resolve()
        .then(() => run(loaded))
        .catch(() => {
          // Scoped step logs and circuit-breaker accounting already ran.
        })
        .finally(() => this.flights.delete(charter.dot_id));
    }
  }
}
const observationLane = new ContinuousOperationLane('observe');
const advanceLane = new ContinuousOperationLane('advance');
export function continuousOperationsInFlight(): boolean {
  return observationLane.inFlight || advanceLane.inFlight;
}

export const DOT_CONTINUOUS_OPERATIONS_SUPERVISOR_STEP: DotSupervisorStep = {
  id: 'dot-continuous-operations',
  async run(now, active) {
    advanceLane.submit(
      active.filter(({ charter }) =>
        charter.authority.allowed_pipelines?.includes(CONTINUOUS_MANAGED_WORK_PIPELINE)
      ),
      (loaded) => runDotContinuousOperationsStep(now, [loaded], { phase: 'advance' })
    );
    const configs = discoverContinuousCadenceConfigs(pathResolver.rootDir(), (ref) => {
      logger.warn(
        `continuous configuration unavailable — reviewed configuration could not be read | next: inspect config | evidence: ${ref}`
      );
    });
    observationLane.submit(
      active.filter(({ charter }) =>
        configs.some(({ config }) => config.enabled && config.schedule && matches(charter, config))
      ),
      (loaded) =>
        runDotContinuousOperationsStep(now, [loaded], { phase: 'observe', configs: () => configs })
    );
  },
};
