export type MissionAssetCategory = 'deliverables' | 'artifacts' | 'outputs' | 'evidence';

export interface MissionHandoffSummary {
  ts: string;
  missionId: string;
  sender: string;
  receiver: string;
  teamRole?: string;
  channel?: string;
  thread?: string;
  performative?: string;
  intent?: string;
  promptExcerpt?: string;
}

/** Select the latest handoff for the client-side mission card. */
export function findLatestMissionHandoff(
  missionId: string,
  handoffs: MissionHandoffSummary[]
): MissionHandoffSummary | null {
  return (
    handoffs
      .filter((handoff) => handoff.missionId === missionId)
      .sort((a, b) => b.ts.localeCompare(a.ts))[0] || null
  );
}
