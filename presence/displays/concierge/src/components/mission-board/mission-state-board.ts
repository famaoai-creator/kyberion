/**
 * Pure model of the `/work` mission state board (MSN-SHELL-IA §1): every
 * mission falls in exactly one of five columns, derived from its lifecycle
 * status (`libs/core/mission/mission-status.ts`). The columns use the same
 * split as the home dashboard's mission tile, so the counts agree.
 *
 *   計画中           planned (agreed and queued to run)
 *   進行中           active
 *   入力待ち・停滞   paused, failed, and any status this board does not know
 *                    (an unknown state needs a person to look, never "done")
 *   レビュー待ち     validating, distilling (result is being checked)
 *   完了             completed, archived
 */

export type MissionBoardColumnId = 'planned' | 'in_progress' | 'waiting' | 'review' | 'done';

export const MISSION_BOARD_COLUMNS: readonly MissionBoardColumnId[] = [
  'planned',
  'in_progress',
  'waiting',
  'review',
  'done',
];

const STATUS_COLUMN: Readonly<Record<string, MissionBoardColumnId>> = {
  active: 'in_progress',
  planned: 'planned',
  paused: 'waiting',
  failed: 'waiting',
  validating: 'review',
  distilling: 'review',
  completed: 'done',
  archived: 'done',
};

export function missionBoardColumn(status: string | undefined | null): MissionBoardColumnId {
  return (status && STATUS_COLUMN[status]) || 'waiting';
}

export interface MissionBoardInput {
  id: string;
  label: string;
  status?: string;
  updatedAt?: string;
}

export interface MissionBoardColumn<T extends MissionBoardInput> {
  id: MissionBoardColumnId;
  count: number;
  /** Most recently updated first, capped at `limit`. */
  missions: T[];
}

function updatedMs(value: string | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Group missions into the five columns; columns keep their order even when empty. */
export function groupMissionBoard<T extends MissionBoardInput>(
  missions: readonly T[],
  limit = 8
): MissionBoardColumn<T>[] {
  const buckets = new Map<MissionBoardColumnId, T[]>(MISSION_BOARD_COLUMNS.map((id) => [id, []]));
  for (const mission of missions) buckets.get(missionBoardColumn(mission.status))!.push(mission);
  return MISSION_BOARD_COLUMNS.map((id) => {
    const all = buckets.get(id)!;
    const sorted = [...all].sort((a, b) => updatedMs(b.updatedAt) - updatedMs(a.updatedAt));
    return { id, count: all.length, missions: sorted.slice(0, Math.max(0, limit)) };
  });
}
