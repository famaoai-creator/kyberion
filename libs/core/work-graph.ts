import type { WorkItem, WorkItemStatus } from './work-coordination.js';

export interface WorkGraphNode {
  item_id: string;
  task_id: string;
  title: string;
  status: WorkItemStatus;
  dependencies: string[];
  dependency_item_ids: string[];
  project_id: string;
  assignee_peer_id?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkGraphEdge {
  from_item_id: string;
  to_item_id: string;
  dependency: string;
}

export type WorkGraphDiagnosticCode =
  'duplicate_task_id' | 'missing_dependency' | 'cycle' | 'blocked_dependency';

export interface WorkGraphDiagnostic {
  code: WorkGraphDiagnosticCode;
  message: string;
  item_id?: string;
  dependency?: string;
}

export interface WorkGraph {
  project_id: string;
  nodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  ready_item_ids: string[];
  blocked_item_ids: string[];
  diagnostics: WorkGraphDiagnostic[];
  valid: boolean;
}

function taskIdForItem(item: WorkItem): string {
  const metadataTaskId = item.metadata?.task_id;
  if (typeof metadataTaskId === 'string' && metadataTaskId.trim()) return metadataTaskId.trim();
  const match = /^mission:[^:]+:(.+)$/.exec(item.source_ref);
  return match?.[1] || item.item_id;
}

function dependencyItemId(
  reference: string,
  byTaskId: Map<string, WorkItem>,
  byItemId: Map<string, WorkItem>
): WorkItem | undefined {
  return byItemId.get(reference) || byTaskId.get(reference);
}

/** Build a deterministic graph view from canonical WorkItems (never from NEXT_TASKS.json). */
export function buildWorkGraph(items: ReadonlyArray<WorkItem>, projectId = ''): WorkGraph {
  const scoped = items.filter((item) => !projectId || item.project_id === projectId);
  const byItemId = new Map(scoped.map((item) => [item.item_id, item]));
  const byTaskId = new Map<string, WorkItem>();
  const diagnostics: WorkGraphDiagnostic[] = [];
  const taskIds = new Map<string, string>();

  for (const item of scoped) {
    const taskId = taskIdForItem(item);
    const previous = taskIds.get(taskId);
    if (previous && previous !== item.item_id) {
      diagnostics.push({
        code: 'duplicate_task_id',
        message: `Duplicate task id: ${taskId}`,
        item_id: item.item_id,
      });
    } else {
      taskIds.set(taskId, item.item_id);
      byTaskId.set(taskId, item);
    }
  }

  const nodes: WorkGraphNode[] = scoped.map((item) => ({
    item_id: item.item_id,
    task_id: taskIdForItem(item),
    title: item.title,
    status: item.status,
    dependencies: [
      ...new Set(
        (item.dependencies || [])
          .map(String)
          .map((value) => value.trim())
          .filter(Boolean)
      ),
    ],
    dependency_item_ids: [],
    project_id: item.project_id,
    ...(item.assignee_peer_id ? { assignee_peer_id: item.assignee_peer_id } : {}),
    ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
  }));
  const nodeById = new Map(nodes.map((node) => [node.item_id, node]));
  const edges: WorkGraphEdge[] = [];

  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      const predecessor = dependencyItemId(dependency, byTaskId, byItemId);
      if (!predecessor) {
        diagnostics.push({
          code: 'missing_dependency',
          message: `Missing dependency: ${dependency}`,
          item_id: node.item_id,
          dependency,
        });
        continue;
      }
      node.dependency_item_ids.push(predecessor.item_id);
      edges.push({ from_item_id: predecessor.item_id, to_item_id: node.item_id, dependency });
      if (predecessor.status === 'blocked') {
        diagnostics.push({
          code: 'blocked_dependency',
          message: `Blocked dependency: ${dependency}`,
          item_id: node.item_id,
          dependency,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visiting.has(itemId)) {
      diagnostics.push({
        code: 'cycle',
        message: `Dependency cycle includes ${itemId}`,
        item_id: itemId,
      });
      return;
    }
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const edge of edges.filter((candidate) => candidate.from_item_id === itemId))
      visit(edge.to_item_id);
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const node of nodes) visit(node.item_id);

  const ready_item_ids = nodes
    .filter((node) => {
      if (node.status !== 'ready' && node.status !== 'backlog') return false;
      if (node.dependency_item_ids.length !== node.dependencies.length) return false;
      return node.dependency_item_ids.every((dependencyId) => {
        const dependency = byItemId.get(dependencyId);
        return dependency?.status === 'done' || dependency?.status === 'archived';
      });
    })
    .map((node) => node.item_id);
  const blocked_item_ids = nodes
    .filter(
      (node) =>
        node.status === 'blocked' ||
        node.dependencies.some((dependency) => {
          const predecessor = dependencyItemId(dependency, byTaskId, byItemId);
          return predecessor?.status === 'blocked';
        })
    )
    .map((node) => node.item_id);

  return {
    project_id: projectId || scoped[0]?.project_id || '',
    nodes,
    edges,
    ready_item_ids,
    blocked_item_ids,
    diagnostics,
    valid: diagnostics.length === 0,
  };
}

export function workGraphNode(graph: WorkGraph, itemId: string): WorkGraphNode | undefined {
  return graph.nodes.find((node) => node.item_id === itemId);
}
