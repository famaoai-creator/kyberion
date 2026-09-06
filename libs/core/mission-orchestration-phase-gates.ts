import * as path from 'node:path';
import {
  evaluateMissionGate,
  writeMissionGateRecord,
  type MissionGateDefinition,
} from './mission-gate-engine.js';
import { evaluateMissionIntentDrift } from './mission-intent-delta.js';
import { latestSnapshot } from './intent-snapshot-store.js';
import { findMissionPath, missionDir, pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import {
  loadMissionPhaseGateDefinitionAtPath,
  type PersistedPhaseGateDefinition,
} from './mission-phase-gate-definition-reader.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';
import {
  loadMissionNextTaskRecordsAtPath,
  type MissionNextTaskRecord,
} from './mission-next-task-reader.js';

function safeMissionPath(missionId: string, relativePath: string, allowMissingLeaf = true): string {
  const missionPath = assertSafeRepositoryPath(
    findMissionPath(missionId) || missionDir(missionId, 'public'),
    { allowMissingLeaf }
  );
  return assertSafeRepositoryPath(path.join(missionPath, relativePath), {
    allowMissingLeaf,
  });
}

export type MissionGateRecord = {
  mission_id?: string;
  gate_id?: string;
  title?: string;
  verdict?: 'pass' | 'fail';
  reason?: string;
  reasons?: string[];
  failure_count?: number;
  checked_at?: string;
  should_realign?: boolean;
  next_status?: string;
  phase?: string;
  position?: string;
  source?: string;
  drift_score?: number;
  review_summary?: Record<string, unknown>;
  evidence_path?: string;
  checks?: Array<{ kind: string; passed: boolean; reason?: string }>;
  override?: boolean;
  override_outcome?: 'passed' | 'rejected';
  note?: string;
  confirmed_by?: string;
  confirmed_at?: string;
  source_gate_id?: string;
};

const MISSION_GATE_RECORD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-gate-record.schema.json'
);

export {
  loadMissionPhaseGateDefinitionAtPath,
  type PersistedPhaseGateDefinition,
} from './mission-phase-gate-definition-reader.js';

/** Load one persisted gate result through schema and mission binding. */
export function loadMissionGateRecordAtPath(
  filePath: string,
  missionId: string
): MissionGateRecord {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[MISSION_GATE_RECORD] record must be a regular file: ${filePath}`);
  }
  const record = defineCatalog<MissionGateRecord>({
    id: 'mission-gate-record',
    path: safeFilePath,
    schema: MISSION_GATE_RECORD_SCHEMA_PATH,
  }).load();
  const expectedMissionId = missionId.trim().toUpperCase();
  if (record.mission_id?.trim().toUpperCase() !== expectedMissionId) {
    throw new Error(
      `[MISSION_GATE_RECORD_SCOPE_MISMATCH] record belongs to ${
        record.mission_id || ''
      }, expected ${expectedMissionId}`
    );
  }
  return record;
}

export interface PhaseExitGateOutcome {
  passed: boolean;
  evaluated: number;
  failures: Array<{ gate_id: string; phase: string; reasons: string[]; prior_failures: number }>;
}

export function loadMissionStateSnapshot(missionId: string): Record<string, unknown> | null {
  const statePath = safeMissionPath(missionId, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;
  return loadMissionStateAtPath(statePath) as unknown as Record<string, unknown> | null;
}

export function missionClassOf(missionId: string): string | undefined {
  const state = loadMissionStateSnapshot(missionId);
  const missionClass = String(
    (state?.classification as Record<string, unknown> | undefined)?.mission_class || ''
  ).trim();
  return missionClass || undefined;
}

export function missionRiskProfileOf(missionId: string): string | undefined {
  const state = loadMissionStateSnapshot(missionId);
  const riskProfile = String(
    (state?.classification as Record<string, unknown> | undefined)?.risk_profile || ''
  ).trim();
  return riskProfile || undefined;
}

function loadMissionGateRecords(missionId: string): MissionGateRecord[] {
  const gateDir = safeMissionPath(missionId, 'gates');
  if (!safeExistsSync(gateDir)) return [];
  return safeReaddir(gateDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        return loadMissionGateRecordAtPath(
          assertSafeRepositoryPath(path.join(gateDir, entry)),
          missionId
        );
      } catch {
        return null;
      }
    })
    .filter((entry): entry is MissionGateRecord => Boolean(entry));
}

export function summarizeMissionGateState(missionId: string): {
  lines: string[];
  reworkCount: number;
} {
  const records = loadMissionGateRecords(missionId);
  const latestByGate = new Map<string, MissionGateRecord>();
  for (const record of records) {
    const gateId = String(record.gate_id || '').trim();
    if (!gateId) continue;
    latestByGate.set(gateId, record);
  }
  const state = loadMissionStateSnapshot(missionId);
  const reworkCount =
    Number(
      state?.context && typeof state.context === 'object'
        ? (state.context as Record<string, unknown>).mission_finish_gate_failure_count
        : 0
    ) || 0;

  const lines = Array.from(latestByGate.entries()).map(([gateId, record]) => {
    const icon = record.verdict === 'pass' ? '✅' : '❌';
    const suffix = record.should_realign ? ' realign' : '';
    const note = record.reason ? ` - ${record.reason}` : '';
    return `${icon} ${gateId}${suffix}${note}`;
  });

  return { lines, reworkCount };
}

export function resolvePhaseGateMode(): 'off' | 'warn' | 'enforce' {
  const raw = String(getRegisteredEnvText('KYBERION_PHASE_GATE_MODE') || 'warn').toLowerCase();
  if (raw === 'enforce') return 'enforce';
  if (raw === 'off') return 'off';
  return 'warn';
}

export function loadMissionPhaseGateDefinitions(missionId: string): PersistedPhaseGateDefinition[] {
  const defsDir = safeMissionPath(missionId, path.join('gates', 'definitions'));
  if (!safeExistsSync(defsDir)) return [];
  return safeReaddir(defsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        return loadMissionPhaseGateDefinitionAtPath(
          assertSafeRepositoryPath(path.join(defsDir, entry)),
          missionId
        );
      } catch {
        return null;
      }
    })
    .filter((entry): entry is PersistedPhaseGateDefinition => Boolean(entry));
}

function enrichGateWithTaskOutcomes(
  missionId: string,
  gate: MissionGateDefinition
): MissionGateDefinition {
  const nextTasksPath = safeMissionPath(missionId, 'NEXT_TASKS.json');
  let tasks: MissionNextTaskRecord[] = [];
  try {
    if (safeExistsSync(nextTasksPath)) {
      tasks = loadMissionNextTaskRecordsAtPath(nextTasksPath, missionId) || [];
    }
  } catch {
    /* no task board — checks keep their declared params */
  }
  const checks = (gate.checks || []).map((check) => {
    if (check.kind !== 'reviewer_approved') return check;
    const params = { ...(check.params || {}) } as Record<string, unknown>;
    if (params.approved !== undefined || params.verdict !== undefined) return check;
    const taskId = String(params.task_id || params.taskId || '');
    if (!taskId) return check;
    const task = tasks.find((entry) => String(entry.task_id || '') === taskId);
    const status = String(task?.status || '');
    return {
      ...check,
      params: {
        ...params,
        approved: status === 'completed' || status === 'accepted',
        reason:
          status === ''
            ? `Review task ${taskId} not found in NEXT_TASKS.json`
            : `Review task ${taskId} status: ${status}`,
      },
    };
  });
  return { ...gate, checks };
}

export async function evaluateMissionPhaseExitGates(
  missionId: string
): Promise<PhaseExitGateOutcome> {
  const definitions = loadMissionPhaseGateDefinitions(missionId).filter(
    (definition) => definition.position === 'exit'
  );
  const priorRecords = loadMissionGateRecords(missionId);
  const failures: PhaseExitGateOutcome['failures'] = [];
  const driftSummary = evaluateMissionIntentDrift(missionId);
  const hasPersistedDriftGate = definitions.some(
    (definition) => definition.gate.id === 'INTENT_DRIFT'
  );
  for (const definition of definitions) {
    const priorFailures = priorRecords.filter(
      (record) => record.gate_id === definition.gate.id && record.verdict === 'fail'
    ).length;
    const evaluation =
      definition.gate.id === 'INTENT_DRIFT' && driftSummary
        ? {
            verdict: driftSummary.passed ? ('pass' as const) : ('fail' as const),
            reasons: driftSummary.passed ? [] : [driftSummary.message],
          }
        : await evaluateMissionGate({
            missionId,
            gate: enrichGateWithTaskOutcomes(missionId, definition.gate),
            evidenceDir: safeMissionPath(missionId, 'gates'),
          });
    if (definition.gate.id === 'INTENT_DRIFT' && driftSummary) {
      writeMissionGateRecord({
        missionId,
        gateId: 'INTENT_DRIFT',
        evidenceDir: safeMissionPath(missionId, 'gates'),
        payload: {
          phase: definition.phase,
          position: 'exit',
          source: 'phase_exit',
          verdict: evaluation.verdict,
          reason: driftSummary.message,
          drift_score: driftSummary.drift_score,
          checked_at: driftSummary.checked_at,
        },
      });
    }
    if (evaluation.verdict !== 'pass') {
      failures.push({
        gate_id: definition.gate.id,
        phase: definition.phase,
        reasons: evaluation.reasons,
        prior_failures: priorFailures,
      });
    }
  }
  // Make INTENT_DRIFT a built-in execution gate for workflows that predate
  // the catalog entry. Missions with no user-origin snapshot remain a clean
  // no-op, preserving deterministic CLI-only and fixture missions.
  if (!hasPersistedDriftGate && driftSummary && driftSummary.verdict !== 'no_history') {
    const priorFailures = priorRecords.filter(
      (record) => record.gate_id === 'INTENT_DRIFT' && record.verdict === 'fail'
    ).length;
    writeMissionGateRecord({
      missionId,
      gateId: 'INTENT_DRIFT',
      evidenceDir: safeMissionPath(missionId, 'gates'),
      payload: {
        phase: latestSnapshot(missionId)?.stage || 'execution',
        position: 'exit',
        source: 'phase_exit',
        verdict: driftSummary.passed ? 'pass' : 'fail',
        reason: driftSummary.message,
        drift_score: driftSummary.drift_score,
        checked_at: driftSummary.checked_at,
      },
    });
    if (!driftSummary.passed) {
      failures.push({
        gate_id: 'INTENT_DRIFT',
        phase: latestSnapshot(missionId)?.stage || 'execution',
        reasons: [driftSummary.message],
        prior_failures: priorFailures,
      });
    }
  }
  return {
    passed: failures.length === 0,
    evaluated:
      definitions.length +
      (!hasPersistedDriftGate && driftSummary && driftSummary.verdict !== 'no_history' ? 1 : 0),
    failures,
  };
}
