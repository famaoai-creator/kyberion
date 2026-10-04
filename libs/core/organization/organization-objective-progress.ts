import { loadOrganizationPurpose } from './organization-operating-model-persistence.js';
import type { KrMeasurementRow } from '../dot/dot-state-paths.js';
import type { OrganizationTier } from './organization-operating-model.js';
import type { OrganizationPurposeRecord } from './organization-operating-model.js';

export type { KrMeasurementRow } from '../dot/dot-state-paths.js';

export interface ObjectiveProgressScope {
  organizationId: string;
  tenantSlug?: string;
  tier: OrganizationTier;
}

export interface ObjectiveProgressDeps {
  /** Returns measurement rows for the org scope; the roll-up picks the latest per (objective, kr). */
  readMeasurements: (scope: ObjectiveProgressScope) => KrMeasurementRow[];
  /** Defaults to the persisted organization purpose. */
  loadPurpose?: (scope: ObjectiveProgressScope) => OrganizationPurposeRecord | null | undefined;
}

export interface ObjectiveKeyResultProgress {
  kr_id: string;
  weight: number;
  value?: number;
  progress?: number;
  measured_at?: string;
}

export interface ObjectiveProgress {
  objective_id: string;
  title: string;
  /** Weighted mean of KR progress (0..1); undefined when any KR is unmeasured or none are defined. */
  progress?: number;
  key_results: ObjectiveKeyResultProgress[];
  unmeasured_krs: string[];
}

export interface OrganizationObjectiveProgress {
  organization_id: string;
  objectives: ObjectiveProgress[];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function rollUpObjectiveProgress(
  scope: ObjectiveProgressScope,
  deps: ObjectiveProgressDeps
): OrganizationObjectiveProgress {
  const purpose = (
    deps.loadPurpose ??
    ((s) => loadOrganizationPurpose(s.organizationId, { tier: s.tier, tenantSlug: s.tenantSlug }))
  )(scope);

  const latest = new Map<string, KrMeasurementRow>();
  for (const row of deps.readMeasurements(scope)) {
    if (row.scope !== 'org' || !row.objective_id) continue;
    if (row.organization_id && row.organization_id !== scope.organizationId) continue;
    if (!Number.isFinite(row.progress)) continue;
    const key = `${row.objective_id}\u0000${row.kr_id}`;
    const prev = latest.get(key);
    if (!prev || row.measured_at >= prev.measured_at) latest.set(key, row);
  }

  const objectives: ObjectiveProgress[] = (purpose?.objectives || []).map((objective) => {
    const krs: ObjectiveKeyResultProgress[] = [];
    const unmeasured: string[] = [];
    for (const kr of objective.key_results || []) {
      const weight = kr.weight !== undefined && kr.weight > 0 ? kr.weight : 1;
      const row = latest.get(`${objective.objective_id}\u0000${kr.kr_id}`);
      if (!row) {
        unmeasured.push(kr.kr_id);
        krs.push({ kr_id: kr.kr_id, weight });
      } else {
        krs.push({
          kr_id: kr.kr_id,
          weight,
          value: row.value,
          progress: clamp01(row.progress),
          measured_at: row.measured_at,
        });
      }
    }
    let progress: number | undefined;
    if (krs.length > 0 && unmeasured.length === 0) {
      const totalWeight = krs.reduce((sum, kr) => sum + kr.weight, 0);
      progress = krs.reduce((sum, kr) => sum + kr.weight * (kr.progress ?? 0), 0) / totalWeight;
    }
    return {
      objective_id: objective.objective_id,
      title: objective.title,
      ...(progress !== undefined ? { progress } : {}),
      key_results: krs,
      unmeasured_krs: unmeasured,
    };
  });
  return { organization_id: scope.organizationId, objectives };
}
