import { syncProjectOperationalStateFromMission } from './project-operational-state-registry.js';
import { loadMissionStateIncludingArchive } from '../mission/mission-state.js';
import { logger } from '../core.js';

export async function syncProjectOperationalStateIfLinked(missionId: string): Promise<void> {
  // finishMission moves the mission to the archive before this sync runs.
  const state = loadMissionStateIncludingArchive(missionId);
  if (!state?.relationships?.project?.project_id) return;
  try {
    syncProjectOperationalStateFromMission({
      mission_id: state.mission_id,
      mission_type: state.mission_type,
      tier: state.tier,
      status: state.status,
      tenant_slug: state.tenant_slug,
      tenant_id: state.tenant_id,
      relationships: state.relationships,
      assigned_persona: state.assigned_persona,
      context: state.context,
      outcome_contract: state.outcome_contract,
    });
  } catch (err: any) {
    logger.warn(`[project-state] sync skipped for ${state.mission_id}: ${err?.message || err}`);
  }
}
