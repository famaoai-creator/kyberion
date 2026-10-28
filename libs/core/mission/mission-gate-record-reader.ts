/** Read-only mission record and classification readers shared with orchestration. */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { resolveMissionDir, tryResolveOwnerScope } from '../owner-scope.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';

/**
 * Path inside the existing mission's own directory. Write paths use this: an
 * unknown mission fails closed (OwnerScopeError).
 */
export function safeMissionPath(
  missionId: string,
  relativePath: string,
  allowMissingLeaf = true
): string {
  const missionPath = assertSafeRepositoryPath(resolveMissionDir(missionId), { allowMissingLeaf });
  return assertSafeRepositoryPath(path.join(missionPath, relativePath), {
    allowMissingLeaf,
  });
}

/** Read-path variant: null for an unknown mission (callers treat it as missing). */
export function existingMissionPath(missionId: string, relativePath: string): string | null {
  return tryResolveOwnerScope({ kind: 'mission', id: missionId })
    ? safeMissionPath(missionId, relativePath)
    : null;
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
  input_digest?: string;
  blocking?: boolean;
  /** Publication order assigned under the per-mission gate writer lock. */
  sequence?: number;
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

export function loadMissionStateSnapshot(missionId: string): Record<string, unknown> | null {
  const statePath = existingMissionPath(missionId, 'mission-state.json');
  if (!statePath || !safeExistsSync(statePath)) return null;
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
