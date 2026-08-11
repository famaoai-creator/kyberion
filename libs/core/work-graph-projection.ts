import * as nodePath from 'node:path';
import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { listWorkItems, type WorkItem, type WorkItemStatus } from './work-coordination.js';
import { buildWorkGraph, type WorkGraph } from './work-graph.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

export interface WorkGraphProjectionOptions {
  missionId: string;
  projectId?: string;
  apply?: boolean;
  /** Test seam; production callers should use the mission resolver. */
  missionPath?: string;
}

export interface WorkGraphProjectionDrift {
  task_id: string;
  kind: 'missing_from_projection' | 'different_from_projection' | 'stale_projection_entry';
  fields: string[];
}

export interface WorkGraphProjectionResult {
  mission_id: string;
  project_id: string;
  next_tasks_path: string;
  projection_mode: 'canonical_work_graph_additive';
  applied: boolean;
  graph_valid: boolean;
  graph_diagnostics: WorkGraph['diagnostics'];
  projected_tasks: Array<Record<string, unknown>>;
  existing_task_count: number;
  drift: WorkGraphProjectionDrift[];
}

export interface CanonicalWorkGraphRead {
  project_id: string;
  items: WorkItem[];
  graph: WorkGraph;
}

type NextTask = Record<string, unknown> & { task_id: string };

function taskIdForItem(item: WorkItem): string {
  const contextTaskId = item.context?.task_id;
  if (contextTaskId?.trim()) return contextTaskId.trim();
  const metadataTaskId = item.metadata?.task_id;
  if (typeof metadataTaskId === 'string' && metadataTaskId.trim()) return metadataTaskId.trim();
  const match = /^mission:[^:]+:(.+)$/u.exec(item.source_ref);
  return match?.[1] || item.item_id;
}

function plannedStatus(status: WorkItemStatus): string {
  switch (status) {
    case 'backlog':
    case 'ready':
      return 'planned';
    case 'in_progress':
      return 'in_progress';
    case 'blocked':
      return 'blocked';
    case 'review':
      return 'reviewed';
    case 'done':
    case 'archived':
      return 'completed';
  }
}

function stringMetadata(item: WorkItem, key: string): string | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringListMetadata(item: WorkItem, key: string): string[] | undefined {
  const value = item.metadata?.[key];
  if (!Array.isArray(value)) return undefined;
  const values = value.map((entry) => String(entry).trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function roleForItem(item: WorkItem): string | undefined {
  const metadataRole = stringMetadata(item, 'team_role');
  if (metadataRole) return metadataRole;
  return item.labels.find((label) => label.startsWith('team_role:'))?.slice('team_role:'.length);
}

function toProjectedTask(item: WorkItem): NextTask {
  const metadata = item.metadata || {};
  const role = roleForItem(item);
  const task: NextTask = {
    task_id: taskIdForItem(item),
    status: plannedStatus(item.status),
    assigned_to: {
      ...(role ? { role } : {}),
      ...(item.assignee_peer_id ? { agent_id: item.assignee_peer_id } : {}),
    },
    description: item.description || item.title,
    dependencies: [
      ...new Set(item.dependencies.map((dependency) => dependency.trim()).filter(Boolean)),
    ],
    acceptance_criteria: stringListMetadata(item, 'acceptance_criteria') || [
      'WorkItem reaches its governed terminal status with durable evidence.',
    ],
    risk: stringMetadata(item, 'risk') || 'medium',
    expected_output_format: stringMetadata(item, 'expected_output_format') || 'files',
    origin: 'canonical_work_graph',
    work_item_id: item.item_id,
    context: item.context ? { ...item.context } : { project_id: item.project_id },
  };
  for (const key of [
    'deliverable',
    'target_path',
    'estimated_scope',
    'phase',
    'phase_kind',
    'review_target',
    'pipeline_ref',
    'artifact_review_profile',
    'artifact_review_receipt',
    'ticket_dispatch',
    'reconciliation',
  ]) {
    const value = ['artifact_review_profile', 'ticket_dispatch', 'reconciliation'].includes(key)
      ? metadata[key]
      : stringMetadata(item, key);
    if (value !== undefined && value !== null) task[key] = value;
  }
  if (metadata.review_target && !task.review_target)
    task.review_target = String(metadata.review_target);
  return task;
}

function readExistingTasks(nextTasksPath: string): NextTask[] {
  if (!safeExistsSync(nextTasksPath)) return [];
  const parsed = JSON.parse(String(safeReadFile(nextTasksPath, { encoding: 'utf8' }) || 'null'));
  if (!Array.isArray(parsed))
    throw new Error(`NEXT_TASKS.json must contain an array: ${nextTasksPath}`);
  return parsed.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).task_id !== 'string'
    ) {
      throw new Error(`NEXT_TASKS.json task ${index + 1} is missing task_id: ${nextTasksPath}`);
    }
    return entry as NextTask;
  });
}

function comparableTask(task: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...task };
  delete copy.last_result;
  delete copy.reconciliation;
  return copy;
}

function driftFor(existing: NextTask[], projected: NextTask[]): WorkGraphProjectionDrift[] {
  const byId = new Map(existing.map((task) => [task.task_id, task]));
  const projectedIds = new Set(projected.map((task) => task.task_id));
  const drift: WorkGraphProjectionDrift[] = [];
  for (const task of projected) {
    const current = byId.get(task.task_id);
    if (!current) {
      drift.push({ task_id: task.task_id, kind: 'missing_from_projection', fields: ['task'] });
      continue;
    }
    const fields = [...new Set([...Object.keys(current), ...Object.keys(task)])].filter(
      (field) =>
        JSON.stringify(comparableTask(current)[field]) !==
        JSON.stringify(comparableTask(task)[field])
    );
    if (fields.length > 0)
      drift.push({ task_id: task.task_id, kind: 'different_from_projection', fields });
  }
  for (const task of existing) {
    if (!projectedIds.has(task.task_id)) {
      drift.push({ task_id: task.task_id, kind: 'stale_projection_entry', fields: ['task'] });
    }
  }
  return drift;
}

function mergedTasks(existing: NextTask[], projected: NextTask[]): NextTask[] {
  const projectedById = new Map(projected.map((task) => [task.task_id, task]));
  const merged = existing.map((task) => projectedById.get(task.task_id) || task);
  const existingIds = new Set(existing.map((task) => task.task_id));
  return [
    ...merged,
    ...projected
      .filter((task) => !existingIds.has(task.task_id))
      .sort((a, b) => a.task_id.localeCompare(b.task_id)),
  ];
}

function assertMissionPathWithinRoot(missionPath: string): void {
  const root = nodePath.resolve(pathResolver.rootDir());
  const resolved = nodePath.resolve(missionPath);
  const relative = nodePath.relative(root, resolved);
  if (relative.startsWith('..') || nodePath.isAbsolute(relative)) {
    throw new Error(`mission path must remain inside the repository: ${missionPath}`);
  }
}

/** Read dispatch/reconciliation state from canonical WorkItems, never NEXT_TASKS. */
export function readCanonicalWorkGraph(projectId: string): CanonicalWorkGraphRead {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error('projectId is required');
  const items = listWorkItems({ projectId: normalizedProjectId });
  const graph = buildWorkGraph(items, normalizedProjectId);
  return { project_id: normalizedProjectId, items, graph };
}

/** Return the additive task-shaped view for consumers that still need task fields. */
export function readCanonicalWorkGraphTasks(projectId: string): Array<Record<string, unknown>> {
  return readCanonicalWorkGraph(projectId)
    .items.map(toProjectedTask)
    .sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
}

/** Project canonical WorkItems into the legacy-compatible NEXT_TASKS view. */
export function projectWorkGraphToNextTasks(
  input: WorkGraphProjectionOptions
): WorkGraphProjectionResult {
  const missionId = input.missionId.trim().toUpperCase();
  if (!missionId) throw new Error('missionId is required');
  const projectId = (input.projectId || missionId).trim();
  const missionPath = input.missionPath || pathResolver.missionDir(missionId, 'public');
  assertMissionPathWithinRoot(missionPath);
  const nextTasksPath = nodePath.join(missionPath, 'NEXT_TASKS.json');
  const canonical = readCanonicalWorkGraph(projectId);
  const { items, graph } = canonical;
  const projectedTasks = items
    .map(toProjectedTask)
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  const existingTasks = readExistingTasks(nextTasksPath);
  const drift = driftFor(existingTasks, projectedTasks);
  let applied = false;
  const hasBlockingProjectionDrift = drift.some(
    (entry) => entry.kind === 'different_from_projection' || entry.kind === 'stale_projection_entry'
  );
  if (input.apply && graph.valid && !hasBlockingProjectionDrift) {
    withExecutionContext(
      'mission_controller',
      () => {
        safeMkdir(missionPath, { recursive: true });
        safeWriteFile(
          nextTasksPath,
          JSON.stringify(mergedTasks(existingTasks, projectedTasks), null, 2)
        );
      },
      'worker'
    );
    applied = true;
  }
  return {
    mission_id: missionId,
    project_id: projectId,
    next_tasks_path: nextTasksPath,
    projection_mode: 'canonical_work_graph_additive',
    applied,
    graph_valid: graph.valid,
    graph_diagnostics: graph.diagnostics,
    projected_tasks: projectedTasks,
    existing_task_count: existingTasks.length,
    drift,
  };
}
