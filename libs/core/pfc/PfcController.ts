import { redactActiveSecretsForHostLog } from '../secret/secret-guard.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '../secure-io.js';

export type Layer =
  'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10' | 'L11' | 'L12';

export interface LayerObservation {
  passed: boolean;
  deferred?: boolean;
  reason?: string;
  fingerprint?: string;
  evidence?: string[];
}

export interface LayerRunOptions {
  countFailure?: boolean;
}
export interface RecoveryAttempt {
  id: string;
  passed: boolean;
  restored?: boolean;
  reason?: string;
}

export interface LayerState {
  status: 'pending' | 'passed' | 'failed';
  attempt_count: number;
  budget_source?: 'recovery';
  last_observation?: LayerObservation & { timestamp: string };
  last_recovery?: RecoveryAttempt & { timestamp: string };
  legacy_observation_attempt_count?: number;
}

export interface PfcState {
  layers: Record<Layer, LayerState>;
}

export interface LayerResult {
  passed: boolean;
  circuit_broken: boolean;
  deferred?: true;
}

function boundedText(value: string, limit: number): string {
  return redactActiveSecretsForHostLog(value, '[REDACTED_SECRET]', 0).slice(0, limit);
}

const PFC_STATE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/pfc-state.schema.json');

/** Load persisted PFC state through the governed schema and file boundary. */
export function loadPfcStateAtPath(stateFilePath: string): PfcState {
  const safeStateFilePath = assertSafeRepositoryPath(stateFilePath, { allowMissingLeaf: true });
  if (!safeLstat(safeStateFilePath).isFile()) {
    throw new Error(`[PFC_STATE] state must be a regular file: ${stateFilePath}`);
  }
  return defineCatalog<PfcState>({
    id: 'pfc-state',
    path: safeStateFilePath,
    schema: PFC_STATE_SCHEMA_PATH,
  }).load();
}

export class PfcController {
  private stateFilePath: string;
  private state: PfcState;
  private readonly MAX_ATTEMPTS = 3;

  constructor(stateFilePath: string) {
    this.stateFilePath = assertSafeRepositoryPath(stateFilePath, { allowMissingLeaf: true });
    this.state = this.loadState();
  }

  private getDefaultState(): PfcState {
    return {
      layers: {
        L0: { status: 'pending', attempt_count: 0 },
        L1: { status: 'pending', attempt_count: 0 },
        L2: { status: 'pending', attempt_count: 0 },
        L3: { status: 'pending', attempt_count: 0 },
        L4: { status: 'pending', attempt_count: 0 },
        L5: { status: 'pending', attempt_count: 0 },
        L6: { status: 'pending', attempt_count: 0 },
        L7: { status: 'pending', attempt_count: 0 },
        L8: { status: 'pending', attempt_count: 0 },
        L9: { status: 'pending', attempt_count: 0 },
        L10: { status: 'pending', attempt_count: 0 },
        L11: { status: 'pending', attempt_count: 0 },
        L12: { status: 'pending', attempt_count: 0 },
      },
    };
  }

  private loadState(): PfcState {
    if (safeExistsSync(this.stateFilePath)) {
      try {
        const parsed = loadPfcStateAtPath(this.stateFilePath);
        // Forward-compat: a state file persisted before a new layer was
        // added won't have that layer's key. Backfill defaults rather than
        // crash the first time the new layer runs.
        return { layers: { ...this.getDefaultState().layers, ...parsed.layers } };
      } catch (err) {
        return this.getDefaultState();
      }
    }
    return this.getDefaultState();
  }

  private updateState<T>(update: (state: PfcState) => T): T {
    return withLockSync(`pfc-state:${this.stateFilePath}`, () => {
      this.state = this.loadState();
      const result = update(this.state);
      defineCatalog<PfcState>({
        id: 'pfc-state',
        path: this.stateFilePath,
        schema: PFC_STATE_SCHEMA_PATH,
      }).validate(this.state);
      safeWriteFile(this.stateFilePath, JSON.stringify(this.state, null, 2));
      return result;
    });
  }

  public getState(): PfcState {
    this.state = this.loadState();
    return this.state;
  }

  /** Count completed recovery commands, never repeated health observations. */
  public recordRecoveryAttempt(layer: Layer, attempt: RecoveryAttempt): void {
    attempt = {
      ...attempt,
      id: boundedText(attempt.id, 128),
      ...(attempt.reason === undefined ? {} : { reason: boundedText(attempt.reason, 2048) }),
    };
    if (!attempt.id.trim()) throw new Error('PFC recovery attempt requires an id');
    this.updateState((state) => {
      const current = state.layers[layer];
      if (current.last_recovery?.id === attempt.id) return;
      this.migrateObservationBudget(current);
      current.last_recovery = { ...attempt, timestamp: new Date().toISOString() };
      if (attempt.passed && attempt.restored === false) return;
      current.attempt_count = attempt.passed
        ? 0
        : Math.min(this.MAX_ATTEMPTS, current.attempt_count + 1);
      current.status = attempt.passed
        ? 'passed'
        : current.attempt_count >= this.MAX_ATTEMPTS
          ? 'failed'
          : 'pending';
    });
  }

  private migrateObservationBudget(current: LayerState): void {
    if (current.budget_source === 'recovery') return;
    current.legacy_observation_attempt_count = current.attempt_count;
    current.attempt_count = 0;
    current.status = 'pending';
    current.budget_source = 'recovery';
  }

  public async runLayer(
    layer: Layer,
    logic: () => Promise<boolean | LayerObservation>,
    options: LayerRunOptions = {}
  ): Promise<LayerResult> {
    const recoveryAtStart = this.loadState().layers[layer].last_recovery?.id;
    // Probes can be slow. Hold the state lock only while committing their result.
    let observation: LayerObservation;
    try {
      const result = await logic();
      observation = typeof result === 'boolean' ? { passed: result } : result;
    } catch (error) {
      observation = {
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return this.updateState((state) => {
      const current = state.layers[layer];
      if (options.countFailure === false) this.migrateObservationBudget(current);
      // A build completed while this probe was running. Its result describes
      // the previous artifact generation and must not undo the recovery result.
      if (current.last_recovery?.id !== recoveryAtStart) {
        observation = {
          ...observation,
          passed: false,
          deferred: true,
          reason: 'Recovery completed during observation; check the current build again',
        };
      }
      observation = {
        ...observation,
        ...(observation.reason === undefined
          ? {}
          : { reason: boundedText(observation.reason, 2048) }),
        ...(observation.fingerprint === undefined
          ? {}
          : { fingerprint: boundedText(observation.fingerprint, 128) }),
        ...(observation.evidence === undefined
          ? {}
          : {
              evidence: observation.evidence.slice(0, 25).map((entry) => boundedText(entry, 2048)),
            }),
      };
      current.last_observation = { ...observation, timestamp: new Date().toISOString() };
      if (!observation.deferred) {
        if (observation.passed) {
          current.status = 'passed';
          current.attempt_count = 0;
        } else {
          if (options.countFailure !== false) {
            current.attempt_count = Math.min(this.MAX_ATTEMPTS, current.attempt_count + 1);
          }
          current.status = current.attempt_count >= this.MAX_ATTEMPTS ? 'failed' : 'pending';
        }
      }
      return {
        passed: !observation.deferred && observation.passed,
        circuit_broken: current.attempt_count >= this.MAX_ATTEMPTS,
        ...(observation.deferred ? { deferred: true as const } : {}),
      };
    });
  }
}
