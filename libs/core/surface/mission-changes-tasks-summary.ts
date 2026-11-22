/**
 * Changes / Tasks summary read-model for Concierge `/ops` mission detail.
 *
 * Projects this-turn artifacts, an uncommitted diff summary, and the child
 * WorkItem tree. CEO / Front Desk stay count + next-action only.
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

export interface MissionArtifactSummary {
  path: string;
  kind: string;
  updated_at: string;
}

export interface MissionUncommittedDiffSummary {
  files_changed: number;
  insertions: number;
  deletions: number;
  /** Capped path list — never a full patch dump. */
  paths: string[];
}

export interface MissionChildWorkItemSummary {
  item_id: string;
  title: string;
  status: string;
  parent_item_id?: string;
  task_id?: string;
}

export interface MissionChangesTasksSummary {
  mission_id: string;
  this_turn_artifacts: MissionArtifactSummary[];
  uncommitted_diff: MissionUncommittedDiffSummary;
  child_work_items: MissionChildWorkItemSummary[];
}

const DEFAULT_PATH_CAP = 20;
const DEFAULT_ARTIFACT_CAP = 30;

export interface BuildMissionChangesTasksSummaryInput {
  missionId: string;
  artifacts?: ReadonlyArray<{
    path: string;
    kind?: string;
    category?: string;
    updatedAt?: string;
    updated_at?: string;
  }>;
  diff?: {
    files_changed?: number;
    insertions?: number;
    deletions?: number;
    paths?: readonly string[];
  };
  children?: ReadonlyArray<{
    item_id: string;
    title: string;
    status: string;
    parent_item_id?: string;
    task_id?: string;
    context?: { task_id?: string; mission_id?: string };
  }>;
  pathCap?: number;
  artifactCap?: number;
}

/**
 * Pure projection. Callers supply evidence / vcs status / WorkItem list;
 * this module never reads the filesystem or dumps raw logs.
 */
export function buildMissionChangesTasksSummary(
  input: BuildMissionChangesTasksSummaryInput
): MissionChangesTasksSummary {
  const pathCap = input.pathCap ?? DEFAULT_PATH_CAP;
  const artifactCap = input.artifactCap ?? DEFAULT_ARTIFACT_CAP;

  const this_turn_artifacts = (input.artifacts ?? [])
    .slice(0, artifactCap)
    .map((artifact) => ({
      path: artifact.path,
      kind: artifact.kind || artifact.category || 'artifact',
      updated_at: artifact.updated_at || artifact.updatedAt || '',
    }));

  const paths = [...(input.diff?.paths ?? [])].slice(0, pathCap);
  const uncommitted_diff: MissionUncommittedDiffSummary = {
    files_changed: input.diff?.files_changed ?? paths.length,
    insertions: input.diff?.insertions ?? 0,
    deletions: input.diff?.deletions ?? 0,
    paths,
  };

  const child_work_items = (input.children ?? [])
    .filter((child) => !child.context?.mission_id || child.context.mission_id === input.missionId)
    .map((child) => ({
      item_id: child.item_id,
      title: child.title,
      status: child.status,
      ...(child.parent_item_id ? { parent_item_id: child.parent_item_id } : {}),
      ...(child.task_id || child.context?.task_id
        ? { task_id: child.task_id || child.context?.task_id }
        : {}),
    }));

  return {
    mission_id: input.missionId,
    this_turn_artifacts,
    uncommitted_diff,
    child_work_items,
  };
}
