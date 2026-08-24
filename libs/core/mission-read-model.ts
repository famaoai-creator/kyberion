/**
 * scripts/refactor/mission-read-model.ts
 * Query/read models for mission listings and status views.
 */

import { findMissionPath } from './path-resolver.js';
import { listMissionsInSearchDirs, loadState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

export interface MissionSummary {
  id: string;
  status: string;
  tier: string;
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  persona: string;
  checkpoints: number;
  lastEvent: string;
}

export interface MissionSummaryScopeFilter {
  tier: 'personal' | 'confidential' | 'public';
  /** `null` means a non-public scope without tenant binding: fail closed. */
  tenantSlug?: string | null;
  organizationId?: string;
  projectId?: string;
}

export interface MissionStatusView {
  state: MissionState;
  missionPath: string | null;
  nextAction: string;
  recentHistory: MissionState['history'];
}

export function listMissionSummaries(
  filterStatus?: string,
  scope?: MissionSummaryScopeFilter
): MissionSummary[] {
  const missions: MissionSummary[] = [];

  for (const { missionId } of listMissionsInSearchDirs()) {
    const state = loadState(missionId);
    if (!state) continue;
    if (filterStatus && state.status !== filterStatus) continue;
    if (scope) {
      const scopeFields = state as unknown as {
        organization_id?: string;
        project_id?: string;
      };
      const organizationId = scopeFields.organization_id;
      const projectId = scopeFields.project_id || state.relationships?.project?.project_id;
      if (state.tier !== scope.tier) continue;
      if (
        scope.tenantSlug === null ||
        (scope.tenantSlug && state.tenant_slug !== scope.tenantSlug)
      ) {
        continue;
      }
      if (scope.organizationId && organizationId !== scope.organizationId) continue;
      if (scope.projectId && projectId !== scope.projectId) continue;
    }
    const lastHist = state.history[state.history.length - 1];
    missions.push({
      id: state.mission_id,
      status: state.status,
      tier: state.tier,
      tenantSlug: state.tenant_slug,
      organizationId: (state as unknown as { organization_id?: string }).organization_id,
      projectId:
        (state as unknown as { project_id?: string }).project_id ||
        state.relationships?.project?.project_id,
      persona: state.assigned_persona,
      checkpoints: state.git.checkpoints.length,
      lastEvent: lastHist ? `${lastHist.event} (${lastHist.ts.slice(0, 16)})` : '-',
    });
  }

  return missions;
}

export function buildMissionStatusView(id: string): MissionStatusView | null {
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) return null;

  const nextActions: Record<string, string> = {
    planned: 'start',
    active: 'checkpoint / verify / delegate',
    validating: 'distill',
    distilling: 'distill',
    completed: 'finish [--seal]',
    paused: 'start (resume)',
    failed: 'start (retry)',
    archived: '(terminal — no further actions)',
  };

  return {
    state,
    missionPath: findMissionPath(upperId),
    nextAction: nextActions[state.status] || '-',
    recentHistory: state.history.slice(-5),
  };
}
