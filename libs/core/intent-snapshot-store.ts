/**
 * Intent Snapshot Store — append-only per-mission snapshot persistence
 * plus a small drift-gate helper that reads the last two snapshots and
 * computes an intent_delta.
 *
 * Implements the storage/emission side of CONCEPT_INTEGRATION_BACKLOG
 * P1-7 residual (lifecycle hooks). Worker stage transitions can call
 * `emitIntentSnapshot` without having to know where snapshots live.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { missionEvidenceDir } from './path-resolver.js';
import { safeAppendFileSync, safeReadFile, safeExistsSync } from './secure-io.js';
import {
  classifyDrift,
  computeIntentDelta,
  DEFAULT_THRESHOLDS,
  type DriftThresholds,
  type IntentBody,
  type IntentDelta,
  type IntentSnapshot,
} from './intent-delta.js';

const SNAPSHOT_FILE = 'intent-snapshots.jsonl';
const DELTA_FILE = 'intent-deltas.jsonl';

export interface EmitSnapshotParams {
  missionId: string;
  stage: string;
  source: IntentSnapshot['source'];
  intent: IntentBody;
  traceRef?: string;
}

function snapshotPath(missionId: string): string | null {
  const dir = missionEvidenceDir(missionId);
  if (!dir) return null;
  return path.join(dir, SNAPSHOT_FILE);
}

function deltaPath(missionId: string): string | null {
  const dir = missionEvidenceDir(missionId);
  if (!dir) return null;
  return path.join(dir, DELTA_FILE);
}

function readJsonl<T>(filePath: string): T[] {
  if (!safeExistsSync(filePath)) return [];
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl(filePath: string, record: unknown): void {
  safeAppendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function listSnapshots(missionId: string): IntentSnapshot[] {
  const file = snapshotPath(missionId);
  if (!file) return [];
  return readJsonl<IntentSnapshot>(file);
}

export function latestSnapshot(missionId: string): IntentSnapshot | null {
  const snapshots = listSnapshots(missionId);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

/**
 * Persist a new snapshot and, if there is a previous one, compute and
 * persist the resulting intent_delta. Returns both so the caller can
 * react (e.g. block on a blocking drift verdict).
 */
export function emitIntentSnapshot(
  params: EmitSnapshotParams,
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): { snapshot: IntentSnapshot; delta: IntentDelta | null } {
  const snapshot: IntentSnapshot = {
    snapshot_id: randomUUID(),
    mission_id: params.missionId,
    stage: params.stage,
    created_at: new Date().toISOString(),
    source: params.source,
    intent: params.intent,
    ...(params.traceRef ? { trace_ref: params.traceRef } : {}),
  };

  const snapFile = snapshotPath(params.missionId);
  if (!snapFile) {
    throw new Error(
      `[intent-snapshot-store] mission evidence dir not found for ${params.missionId}`,
    );
  }

  const previous = latestSnapshot(params.missionId);
  appendJsonl(snapFile, snapshot);

  let delta: IntentDelta | null = null;
  if (previous) {
    delta = computeIntentDelta(previous, snapshot, thresholds);
    const deltaFile = deltaPath(params.missionId);
    if (deltaFile) appendJsonl(deltaFile, delta);
  }

  return { snapshot, delta };
}

export interface IntentDriftGateResult {
  passed: boolean;
  verdict: IntentDelta['drift_verdict'] | 'no_history';
  driftScore: number;
  delta: IntentDelta | null;
  message: string;
}

/**
 * Evaluate the INTENT_DRIFT review gate for a mission. Reads the last
 * two snapshots (or evaluates against an explicit snapshot pair) and
 * compares the resulting drift_verdict to the blocking threshold.
 */
export function evaluateIntentDriftGate(
  missionId: string,
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): IntentDriftGateResult {
  const snapshots = listSnapshots(missionId);
  if (snapshots.length < 2) {
    return {
      passed: true,
      verdict: 'no_history',
      driftScore: 0,
      delta: null,
      message:
        snapshots.length === 0
          ? 'no snapshots yet — gate passes by default'
          : 'only one snapshot — need at least two to assess drift',
    };
  }

  const from = snapshots[snapshots.length - 2];
  const to = snapshots[snapshots.length - 1];
  const delta = computeIntentDelta(from, to, thresholds);
  const passed = delta.drift_verdict !== 'blocking';

  return {
    passed,
    verdict: delta.drift_verdict,
    driftScore: delta.drift_score,
    delta,
    message: passed
      ? `intent drift verdict=${delta.drift_verdict}, score=${delta.drift_score}`
      : `intent drift blocks progression (score=${delta.drift_score}, threshold=${thresholds.blocking})`,
  };
}

/** Map a Kyberion mission stage to an intent-loop phase (see INTENT_LOOP_CONCEPT.md). */
export function mapStageToLoopPhase(missionStage: string): string {
  switch (missionStage) {
    case 'intake':
      return 'receive';
    case 'classification':
      return 'clarify';
    case 'planning':
    case 'contract_authoring':
      return 'preserve';
    case 'preflight':
    case 'execution':
      return 'execute';
    case 'verification':
      return 'verify';
    case 'delivery':
    case 'retrospective':
      return 'learn';
    default:
      return missionStage;
  }
}

/**
 * Reclassify a drift score against custom thresholds. Thin convenience
 * so callers that want policy-specific thresholds (e.g. decision_support
 * missions where even minor drift matters) don't have to recompute the
 * delta.
 */
export function reclassifyDrift(
  delta: IntentDelta,
  thresholds: DriftThresholds,
): IntentDelta['drift_verdict'] {
  return classifyDrift(delta.drift_score, thresholds);
}
