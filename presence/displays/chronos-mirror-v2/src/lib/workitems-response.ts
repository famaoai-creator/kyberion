import { isRecord } from '@agent/core/foundation/primitives';

export type ClientWorkItem = {
  item_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  source: string;
  source_ref: string;
  project_id: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels: string[];
  dependencies: string[];
  created_at: string;
  updated_at: string;
  context?: {
    organization_id?: string;
    mission_id?: string;
    project_id?: string;
    task_id?: string;
    tenant_slug?: string;
    work_shape?: string;
    source?: string;
    warnings?: string[];
  };
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
  metadata?: Record<string, unknown>;
};

export type ClientWorkItemLineage = {
  hierarchy: string[];
  nodes: Array<{ key: string; kind: string; id: string; item_count: number }>;
  edges: Array<{ from: string; to: string; relationship: string; item_count: number }>;
  total_items: number;
  complete_chain_items: number;
  incomplete_chain_items: number;
  missing_by_kind: Record<string, number>;
};

export type ClientWorkItemsResponse = {
  ok: true;
  statuses: string[];
  items: ClientWorkItem[];
  scope: string;
  view: string;
  quality?: {
    explicit_context: number;
    migrated_context: number;
    missing_context: number;
  };
  lineage?: ClientWorkItemLineage;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SCOPES = new Set([
  'organization',
  'home',
  'work_items',
  'operations',
  'missions',
  'governance',
]);
const VIEWS = new Set(['all', 'actionable', 'active', 'history']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function nonEmptyString(value: unknown): value is string {
  return string(value) && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || string(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(string);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseContext(value: unknown): ClientWorkItem['context'] | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const fields = [
    'organization_id',
    'mission_id',
    'project_id',
    'task_id',
    'tenant_slug',
    'work_shape',
    'source',
  ] as const;
  if (
    fields.some((field) => !optionalString(value[field])) ||
    !optionalStringArray(value.warnings)
  ) {
    return undefined;
  }
  return {
    ...Object.fromEntries(
      fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]])
    ),
    ...(value.warnings !== undefined ? { warnings: value.warnings } : {}),
  } as ClientWorkItem['context'];
}

function optionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || stringArray(value);
}

export function parseWorkItem(value: unknown): ClientWorkItem | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  if (
    !nonEmptyString(value.item_id) ||
    !string(value.title) ||
    !string(value.description) ||
    !nonEmptyString(value.status) ||
    !string(value.priority) ||
    !string(value.source) ||
    !string(value.source_ref) ||
    !string(value.project_id) ||
    !stringArray(value.labels) ||
    !stringArray(value.dependencies) ||
    !string(value.created_at) ||
    !string(value.updated_at) ||
    !optionalString(value.assignee_peer_id) ||
    !optionalString(value.assignee_user_id) ||
    !optionalString(value.claimed_by_peer_id) ||
    !optionalString(value.claimed_by_user_id) ||
    (value.context !== undefined && !parseContext(value.context)) ||
    (value.metadata !== undefined && (!isRecord(value.metadata) || !hasSafeTree(value.metadata)))
  ) {
    return undefined;
  }
  return {
    item_id: value.item_id,
    title: value.title,
    description: value.description,
    status: value.status,
    priority: value.priority,
    source: value.source,
    source_ref: value.source_ref,
    project_id: value.project_id,
    ...(value.assignee_peer_id !== undefined ? { assignee_peer_id: value.assignee_peer_id } : {}),
    ...(value.assignee_user_id !== undefined ? { assignee_user_id: value.assignee_user_id } : {}),
    labels: value.labels,
    dependencies: value.dependencies,
    created_at: value.created_at,
    updated_at: value.updated_at,
    ...(value.context !== undefined ? { context: parseContext(value.context) } : {}),
    ...(value.claimed_by_peer_id !== undefined
      ? { claimed_by_peer_id: value.claimed_by_peer_id }
      : {}),
    ...(value.claimed_by_user_id !== undefined
      ? { claimed_by_user_id: value.claimed_by_user_id }
      : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
  };
}

function parseLineage(value: unknown): ClientWorkItemLineage | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  if (
    !stringArray(value.hierarchy) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !nonNegativeInteger(value.total_items) ||
    !nonNegativeInteger(value.complete_chain_items) ||
    !nonNegativeInteger(value.incomplete_chain_items) ||
    !isRecord(value.missing_by_kind) ||
    Object.values(value.missing_by_kind).some((entry) => !nonNegativeInteger(entry))
  ) {
    return undefined;
  }
  const nodes = value.nodes.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.key) ||
      !nonEmptyString(entry.kind) ||
      !nonEmptyString(entry.id) ||
      !nonNegativeInteger(entry.item_count)
    ) {
      return undefined;
    }
    return { key: entry.key, kind: entry.kind, id: entry.id, item_count: entry.item_count };
  });
  const edges = value.edges.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.from) ||
      !nonEmptyString(entry.to) ||
      !nonEmptyString(entry.relationship) ||
      !nonNegativeInteger(entry.item_count)
    ) {
      return undefined;
    }
    return {
      from: entry.from,
      to: entry.to,
      relationship: entry.relationship,
      item_count: entry.item_count,
    };
  });
  return nodes.every((entry) => entry) && edges.every((entry) => entry)
    ? {
        hierarchy: value.hierarchy,
        nodes: nodes as ClientWorkItemLineage['nodes'],
        edges: edges as ClientWorkItemLineage['edges'],
        total_items: value.total_items,
        complete_chain_items: value.complete_chain_items,
        incomplete_chain_items: value.incomplete_chain_items,
        missing_by_kind: value.missing_by_kind as Record<string, number>,
      }
    : undefined;
}

export function parseWorkItemsResponse(value: unknown): ClientWorkItemsResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    !stringArray(value.statuses) ||
    !Array.isArray(value.items) ||
    typeof value.scope !== 'string' ||
    !SCOPES.has(value.scope) ||
    typeof value.view !== 'string' ||
    !VIEWS.has(value.view) ||
    (value.quality !== undefined && !isRecord(value.quality)) ||
    (value.lineage !== undefined && !parseLineage(value.lineage))
  ) {
    return undefined;
  }
  if (
    value.quality &&
    (!nonNegativeInteger(value.quality.explicit_context) ||
      !nonNegativeInteger(value.quality.migrated_context) ||
      !nonNegativeInteger(value.quality.missing_context))
  ) {
    return undefined;
  }
  const items = value.items.map(parseWorkItem);
  return items.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    ? {
        ok: true,
        statuses: value.statuses,
        items,
        scope: value.scope,
        view: value.view,
        ...(value.quality
          ? {
              quality: {
                explicit_context: value.quality.explicit_context,
                migrated_context: value.quality.migrated_context,
                missing_context: value.quality.missing_context,
              },
            }
          : {}),
        ...(value.lineage ? { lineage: parseLineage(value.lineage) } : {}),
      }
    : undefined;
}

export function parseWorkItemMutationResponse(
  value: unknown
): { ok: true; item: ClientWorkItem } | undefined {
  if (!isRecord(value) || !hasSafeTree(value) || value.ok !== true) return undefined;
  const item = parseWorkItem(value.item);
  return item ? { ok: true, item } : undefined;
}
