import type { WorkItem, WorkItemContext, WorkItemStatus } from './work-coordination.js';

export type WorkVisibilityScope =
  'organization' | 'home' | 'work_items' | 'operations' | 'missions' | 'governance';

export type WorkVisibilityView = 'all' | 'actionable' | 'active' | 'history';

export interface ResolvedWorkItemContext extends WorkItemContext {
  source: 'explicit' | 'legacy' | 'inferred';
  warnings: string[];
}

export interface VisibleWorkItem extends WorkItem {
  context: ResolvedWorkItemContext;
}

export const WORK_ITEM_LINEAGE_KEYS = [
  'tenant_slug',
  'organization_id',
  'project_id',
  'mission_id',
  'task_id',
] as const;

export type WorkItemLineageKey = (typeof WORK_ITEM_LINEAGE_KEYS)[number];

export interface WorkItemLineageNode {
  key: string;
  kind: WorkItemLineageKey;
  id: string;
  item_count: number;
}

export interface WorkItemLineageEdge {
  from: string;
  to: string;
  relationship: 'contains';
  item_count: number;
}

export interface WorkItemLineage {
  hierarchy: readonly WorkItemLineageKey[];
  nodes: WorkItemLineageNode[];
  edges: WorkItemLineageEdge[];
  total_items: number;
  complete_chain_items: number;
  incomplete_chain_items: number;
  missing_by_kind: Record<WorkItemLineageKey, number>;
}

export interface WorkVisibilityProjection {
  scope: WorkVisibilityScope;
  view: WorkVisibilityView;
  items: VisibleWorkItem[];
  counts: Record<WorkItemStatus, number>;
  quality: {
    explicit_context: number;
    migrated_context: number;
    missing_context: number;
    warnings: string[];
  };
  lineage: WorkItemLineage;
}

export interface WorkVisibilityViewer {
  tenantSlugs: string[] | 'all';
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
}

export class WorkVisibilityScopeError extends Error {
  readonly status = 403;

  constructor(
    public readonly requestedTenant: string,
    public readonly kind: 'tenant' | 'organization' | 'project' = 'tenant'
  ) {
    super(`viewer is not authorized for ${kind} '${requestedTenant}'`);
    this.name = 'WorkVisibilityScopeError';
  }
}

export function resolveWorkVisibilityIds(
  kind: 'organization' | 'project',
  allowed: string[] | 'all' | undefined,
  requested?: string
): string[] | 'all' {
  const normalized = requested?.trim() || undefined;
  if (normalized && allowed !== 'all' && allowed && !allowed.includes(normalized)) {
    throw new WorkVisibilityScopeError(normalized, kind);
  }
  if (normalized) return [normalized];
  return allowed ?? 'all';
}

export function resolveWorkVisibilityTenants(
  viewer: WorkVisibilityViewer,
  requestedTenant?: string
): string[] | 'all' {
  const requested = requestedTenant?.trim() || undefined;
  if (viewer.tenantSlugs === 'all') return requested ? [requested] : 'all';
  if (requested && !viewer.tenantSlugs.includes(requested)) {
    throw new WorkVisibilityScopeError(requested);
  }
  return requested ? [requested] : viewer.tenantSlugs;
}

const ACTIVE_STATUSES: WorkItemStatus[] = ['ready', 'in_progress', 'blocked', 'review'];
const HISTORY_STATUSES: WorkItemStatus[] = ['done', 'archived'];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return undefined;
}

function missionFromLabel(labels: string[]): string | undefined {
  const label = labels.find((entry) => entry.startsWith('mission:'));
  return label ? stringValue(label.slice('mission:'.length)) : undefined;
}

/** Resolve canonical context while making migration debt visible to callers. */
export function resolveWorkItemContext(item: WorkItem): ResolvedWorkItemContext {
  const explicit = record(item.context);
  const metadata = record(item.metadata);
  const organizationId = firstString(explicit.organization_id, metadata.organization_id);
  const tenantSlug = firstString(explicit.tenant_slug, metadata.tenant_slug);
  const missionId = firstString(
    explicit.mission_id,
    metadata.mission_id,
    missionFromLabel(item.labels || [])
  );
  const projectId = firstString(explicit.project_id, item.project_id);
  const taskId = firstString(explicit.task_id, metadata.task_id);
  const workShape = firstString(
    explicit.work_shape,
    metadata.work_shape
  ) as WorkItemContext['work_shape'];
  const context: WorkItemContext = {
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(missionId ? { mission_id: missionId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(workShape ? { work_shape: workShape } : {}),
  };
  const hasExplicitContext = Object.keys(explicit).some((key) => stringValue(explicit[key]));
  const hasLegacyContext = Boolean(
    metadata.mission_id ||
    metadata.organization_id ||
    metadata.tenant_slug ||
    metadata.task_id ||
    metadata.work_shape ||
    missionFromLabel(item.labels || [])
  );
  const warnings: string[] = [];
  if (!hasExplicitContext && hasLegacyContext) {
    warnings.push(
      '[DEPRECATED] work item context is carried by legacy metadata/labels; set typed context on creation'
    );
  }
  if (!context.mission_id && !context.project_id)
    warnings.push('missing mission_id and project_id');
  return {
    ...context,
    source: hasExplicitContext ? 'explicit' : hasLegacyContext ? 'legacy' : 'inferred',
    warnings,
  };
}

function matchesScope(item: VisibleWorkItem, scope: WorkVisibilityScope): boolean {
  const context = item.context;
  switch (scope) {
    case 'home':
    case 'operations':
      return ACTIVE_STATUSES.includes(item.status);
    case 'missions':
      return Boolean(context.mission_id);
    case 'governance':
      return (
        context.work_shape === 'governance_cadence' ||
        item.labels.some((label) => label === 'governance' || label.startsWith('governance:')) ||
        item.status === 'review'
      );
    case 'organization':
    case 'work_items':
    default:
      return true;
  }
}

function matchesView(item: VisibleWorkItem, view: WorkVisibilityView): boolean {
  if (view === 'actionable' || view === 'active') return ACTIVE_STATUSES.includes(item.status);
  if (view === 'history') return HISTORY_STATUSES.includes(item.status);
  return true;
}

function lineageKey(kind: WorkItemLineageKey, id: string): string {
  return `${kind}:${id}`;
}

/** Build the shared tenant → organization → project → mission → task graph. */
export function buildWorkItemLineage(items: VisibleWorkItem[]): WorkItemLineage {
  const nodes = new Map<string, WorkItemLineageNode>();
  const edges = new Map<string, WorkItemLineageEdge>();
  const missingByKind = Object.fromEntries(
    WORK_ITEM_LINEAGE_KEYS.map((kind) => [kind, 0])
  ) as Record<WorkItemLineageKey, number>;
  let completeChainItems = 0;

  for (const item of items) {
    const present = WORK_ITEM_LINEAGE_KEYS.map((kind) => ({
      kind,
      id: stringValue(item.context[kind]),
    }));
    if (present.every((entry) => entry.id)) completeChainItems += 1;
    for (const entry of present) {
      if (!entry.id) {
        missingByKind[entry.kind] += 1;
        continue;
      }
      const key = lineageKey(entry.kind, entry.id);
      const node = nodes.get(key);
      if (node) node.item_count += 1;
      else {
        nodes.set(key, {
          key,
          kind: entry.kind,
          id: entry.id,
          item_count: 1,
        });
      }
    }

    for (let index = 1; index < present.length; index += 1) {
      const previous = present[index - 1];
      const current = present[index];
      // Do not bridge over a missing parent: tenant -> project would falsely
      // imply that the organization link was known and authorized.
      if (!previous.id || !current.id) continue;
      const from = lineageKey(previous.kind, previous.id);
      const to = lineageKey(current.kind, current.id);
      const key = `${from}->${to}`;
      const edge = edges.get(key);
      if (edge) edge.item_count += 1;
      else edges.set(key, { from, to, relationship: 'contains', item_count: 1 });
    }
  }

  return {
    hierarchy: WORK_ITEM_LINEAGE_KEYS,
    nodes: [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key)),
    edges: [...edges.values()].sort((a, b) =>
      `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)
    ),
    total_items: items.length,
    complete_chain_items: completeChainItems,
    incomplete_chain_items: items.length - completeChainItems,
    missing_by_kind: missingByKind,
  };
}

/** Shared projection consumed by Work Items, Home, Operations, Missions and Governance. */
export function buildWorkVisibilityProjection(input: {
  items: WorkItem[];
  viewer: WorkVisibilityViewer;
  scope?: WorkVisibilityScope;
  view?: WorkVisibilityView;
  tenantSlug?: string;
  organizationId?: string;
  missionId?: string;
  projectId?: string;
}): WorkVisibilityProjection {
  const scope = input.scope || 'work_items';
  const view = input.view || 'all';
  const tenantScope = resolveWorkVisibilityTenants(input.viewer, input.tenantSlug);
  const organizationScope = resolveWorkVisibilityIds(
    'organization',
    input.viewer.organizationIds,
    input.organizationId
  );
  const projectScope = resolveWorkVisibilityIds(
    'project',
    input.viewer.projectIds,
    input.projectId
  );
  const projected = input.items
    .map((item) => ({ ...item, context: resolveWorkItemContext(item) }))
    .filter((item) => matchesScope(item, scope) && matchesView(item, view))
    .filter((item) =>
      tenantScope === 'all'
        ? true
        : Boolean(item.context.tenant_slug && tenantScope.includes(item.context.tenant_slug))
    )
    .filter(
      (item) =>
        organizationScope === 'all' ||
        Boolean(
          item.context.organization_id && organizationScope.includes(item.context.organization_id)
        )
    )
    .filter((item) => !input.missionId || item.context.mission_id === input.missionId)
    .filter(
      (item) =>
        projectScope === 'all' ||
        Boolean(item.context.project_id && projectScope.includes(item.context.project_id))
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const statuses: WorkItemStatus[] = [
    'backlog',
    'ready',
    'in_progress',
    'blocked',
    'review',
    'done',
    'archived',
  ];
  const counts = Object.fromEntries(
    statuses.map((status) => [status, projected.filter((item) => item.status === status).length])
  ) as Record<WorkItemStatus, number>;
  const quality = {
    explicit_context: projected.filter((item) => item.context.source === 'explicit').length,
    migrated_context: projected.filter((item) => item.context.source === 'legacy').length,
    missing_context: projected.filter((item) =>
      item.context.warnings.some((warning) => warning.startsWith('missing'))
    ).length,
    warnings: [...new Set(projected.flatMap((item) => item.context.warnings))],
  };
  return {
    scope,
    view,
    items: projected,
    counts,
    quality,
    lineage: buildWorkItemLineage(projected),
  };
}
