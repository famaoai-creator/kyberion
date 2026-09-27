export interface MissionSeedAssessmentSummary {
  total: number;
  eligible: number;
  flagged: number;
  unassessed: number;
  promotable: number;
  flagged_seed_ids: string[];
  eligible_seed_ids: string[];
  promoted_seed_ids: string[];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function summarizeMissionSeedAssessment(
  missionSeeds: unknown[]
): MissionSeedAssessmentSummary {
  const seeds = asArray<any>(missionSeeds);
  const flaggedSeeds = seeds.filter(
    (seed) =>
      seed?.metadata?.mission_seed_assessment && !seed.metadata.mission_seed_assessment.eligible
  );
  const eligibleSeeds = seeds.filter((seed) => seed?.metadata?.mission_seed_assessment?.eligible);
  const promotedSeeds = seeds.filter((seed) => Boolean(seed?.promoted_mission_id));
  return {
    total: seeds.length,
    eligible: eligibleSeeds.length,
    flagged: flaggedSeeds.length,
    unassessed: seeds.length - eligibleSeeds.length - flaggedSeeds.length,
    promotable: seeds.filter(
      (seed) =>
        !seed.promoted_mission_id &&
        (!seed?.metadata?.mission_seed_assessment || seed.metadata.mission_seed_assessment.eligible)
    ).length,
    flagged_seed_ids: flaggedSeeds.map((seed) => String(seed?.seed_id || '')).filter(Boolean),
    eligible_seed_ids: eligibleSeeds.map((seed) => String(seed?.seed_id || '')).filter(Boolean),
    promoted_seed_ids: promotedSeeds.map((seed) => String(seed?.seed_id || '')).filter(Boolean),
  };
}
