import * as nodePath from 'node:path';
import { withExecutionContext } from './authority.js';
import { readJson } from './foundation/json.js';
import { parseMissionNextTaskObjects } from './mission-next-task-reader.js';
import { findMissionPath, pathResolver } from './path-resolver.js';
import { listWorkItems, type WorkItem, type WorkItemStatus } from './work-coordination.js';
import { buildWorkGraph, type WorkGraph } from './work-graph.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';

export interface WorkGraphProjectionOptions {
  missionId: string;
  projectId?: string;
  tenantSlug?: string;
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

function dependenciesForItem(item: WorkItem): string[] {
  const canonical = (item.dependencies || [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  if (canonical.length > 0) return [...new Set(canonical)];
  const metadata = item.metadata?.dependencies;
  return Array.isArray(metadata)
    ? [
        ...new Set(
          metadata
            .map(String)
            .map((value) => value.trim())
            .filter(Boolean)
        ),
      ]
    : [];
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
    dependencies: dependenciesForItem(item),
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
  const parsed = parseMissionNextTaskObjects(readJson<unknown>(nextTasksPath));
  if (!parsed) throw new Error(`NEXT_TASKS.json must contain an array: ${nextTasksPath}`);
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

function isManagedProcessTask(task: NextTask): boolean {
  const ticketDispatch = task.ticket_dispatch;
  const ticketWorkItemId =
    ticketDispatch && typeof ticketDispatch === 'object'
      ? (ticketDispatch as Record<string, unknown>).work_item_id
      : undefined;
  return (
    task.origin === 'process_template' &&
    (typeof task.work_item_id === 'string' || typeof ticketWorkItemId === 'string')
  );
}

function canonicalTaskFields(task: Record<string, unknown>): string[] {
  return ['status', 'assigned_to', 'dependencies', 'work_item_id', 'context'];
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
    const fields = (
      isManagedProcessTask(current)
        ? canonicalTaskFields(task)
        : [...new Set([...Object.keys(current), ...Object.keys(task)])]
    ).filter(
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
  const merged = existing.map((task) => {
    const projection = projectedById.get(task.task_id);
    if (!projection) return task;
    if (!isManagedProcessTask(task)) return projection;
    // Process templates own the narrative and dispatch history. The Work
    // Graph owns the execution facts that change at runtime.
    return {
      ...task,
      status: projection.status,
      assigned_to: projection.assigned_to,
      dependencies: projection.dependencies,
      work_item_id: projection.work_item_id,
      context: projection.context,
    };
  });
  const existingIds = new Set(existing.map((task) => task.task_id));
  return [
    ...merged,
    ...projected
      .filter((task) => !existingIds.has(task.task_id))
      .sort((a, b) => a.task_id.localeCompare(b.task_id)),
  ];
}

function assertMissionPathWithinRoot(missionPath: string): string {
  return assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });
}

/** Read dispatch/reconciliation state from canonical WorkItems, never NEXT_TASKS. */
export function readCanonicalWorkGraph(
  projectId: string,
  options: { tenantSlug?: string } = {}
): CanonicalWorkGraphRead {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) throw new Error('projectId is required');
  const tenantSlug = options.tenantSlug?.trim();
  const items = listWorkItems({
    projectId: normalizedProjectId,
    ...(tenantSlug ? { tenantSlugs: [tenantSlug] } : {}),
  });
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
  // A mission's tier is canonical state, not a presentation default. Resolve
  // an existing mission first so a confidential tenant mission is never
  // projected into the public compatibility path. The confidential fallback
  // is only used for a not-yet-created mission and preserves the secure
  // default for an apply operation.
  const missionPath =
    input.missionPath ||
    findMissionPath(missionId) ||
    pathResolver.missionDir(missionId, 'confidential', input.tenantSlug);
  const safeMissionPath = assertMissionPathWithinRoot(missionPath);
  const nextTasksPath = assertSafeRepositoryPath(
    nodePath.join(safeMissionPath, 'NEXT_TASKS.json'),
    { allowMissingLeaf: true }
  );
  const canonical = readCanonicalWorkGraph(projectId, {
    ...(input.tenantSlug?.trim() ? { tenantSlug: input.tenantSlug.trim() } : {}),
  });
  const { items, graph } = canonical;
  const projectedTasks = items
    .map(toProjectedTask)
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
  const existingTasks = readExistingTasks(nextTasksPath);
  const drift = driftFor(existingTasks, projectedTasks);
  let applied = false;
  const managedTaskIds = new Set(
    existingTasks.filter(isManagedProcessTask).map((task) => task.task_id)
  );
  const hasBlockingProjectionDrift = drift.some(
    (entry) =>
      entry.kind === 'stale_projection_entry' ||
      (entry.kind === 'different_from_projection' && !managedTaskIds.has(entry.task_id))
  );
  if (input.apply && graph.valid && !hasBlockingProjectionDrift) {
    withExecutionContext(
      'mission_controller',
      () => {
        safeMkdir(safeMissionPath, { recursive: true });
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
