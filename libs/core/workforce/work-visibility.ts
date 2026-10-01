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

/**
 * D2: legacy display-only reader for `mission:<id>` labels.
 *
 * Labels are display-only. Typed `WorkItemContext.mission_id` (canonical order:
 * `tenant_slug → organization_id → project_id → mission_id → task_id`,
 * see `libs/core/entity-scope.ts` ENTITY_SCOPE_HIERARCHY) is the source of truth
 * for search and restoration. This helper exists solely as the last-resort
 * backward-compatibility fallback inside {@link resolveMissionId}.
 *
 * @deprecated set typed `context.mission_id` on creation instead.
 */
function legacyMissionIdFromLabels(labels: string[]): string | undefined {
  const label = labels.find((entry) => entry.startsWith('mission:'));
  return label ? stringValue(label.slice('mission:'.length)) : undefined;
}

/** Primary mission-id source: typed context first, legacy metadata second. */
function missionIdFromTypedContext(
  explicit: Record<string, unknown>,
  metadata: Record<string, unknown>
): string | undefined {
  return firstString(explicit.mission_id, metadata.mission_id);
}

/**
 * D2: context-first mission resolution with labels as backward-compatible fallback.
 *
 * Resolution order is `context.mission_id → metadata.mission_id → mission:<id>`
 * display label. Results are identical to the previous label-inclusive lookup
 * for well-formed items (context and label agree) and for legacy label-only
 * items (fallback still applies); context-only items now resolve where the old
 * label-dependent search missed them.
 */
export function resolveMissionId(item: Pick<WorkItem, 'labels' | 'context' | 'metadata'>): {
  missionId: string | undefined;
  fromLegacyLabels: boolean;
} {
  const explicit = record(item.context);
  const metadata = record(item.metadata);
  const typed = missionIdFromTypedContext(explicit, metadata);
  if (typed) return { missionId: typed, fromLegacyLabels: false };
  const legacy = legacyMissionIdFromLabels(item.labels || []);
  return { missionId: legacy, fromLegacyLabels: legacy !== undefined };
}

/**
 * D2: context-mandatory mission match for search / restoration paths.
 * Only the canonical typed context can establish mission membership.
 * Legacy metadata and labels remain available for display migration warnings.
 */
export function matchesMissionId(
  item: Pick<WorkItem, 'labels' | 'context' | 'metadata'>,
  missionId: string
): boolean {
  return stringValue(record(item.context).mission_id) === missionId;
}

/** Resolve canonical context while making migration debt visible to callers. */
export function resolveWorkItemContext(item: WorkItem): ResolvedWorkItemContext {
  const explicit = record(item.context);
  const metadata = record(item.metadata);
  const organizationId = firstString(explicit.organization_id, metadata.organization_id);
  const tenantSlug = firstString(explicit.tenant_slug, metadata.tenant_slug);
  // D2: mission resolution is context-mandatory; `mission:<id>` labels are a
  // display-only backward-compatibility fallback (see resolveMissionId).
  const resolvedMission = resolveMissionId(item);
  const missionId = resolvedMission.missionId;
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
    legacyMissionIdFromLabels(item.labels || [])
  );
  const warnings: string[] = [];
  if (!hasExplicitContext && hasLegacyContext) {
    warnings.push(
      '[DEPRECATED] work item context is carried by legacy metadata/labels; set typed context on creation'
    );
  }
  // D2: keep the generic legacy warning above for backward compatibility, and
  // additionally surface the label-only mission fallback so remaining
  // `mission:<id>` display labels can be migrated toward typed context.
  if (resolvedMission.fromLegacyLabels && resolvedMission.missionId) {
    warnings.push(
      `[DEPRECATED] mission_id '${resolvedMission.missionId}' resolved from display label; set context.mission_id on creation`
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

/**
 * D2: governance matching is context-mandatory first, labels second.
 * `context.work_shape === 'governance_cadence'` is authoritative; the
 * `governance` / `governance:*` display labels are a backward-compatible
 * fallback (taxonomy: `knowledge/product/schemas/workitem-label-taxonomy.schema.json`).
 * The `review` status clause is unchanged.
 */
function matchesGovernanceScope(item: VisibleWorkItem): boolean {
  if (item.context.work_shape === 'governance_cadence') return true;
  if (item.labels.some((label) => label === 'governance' || label.startsWith('governance:')))
    return true;
  return item.status === 'review';
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
      return matchesGovernanceScope(item);
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
    .filter((item) => !input.missionId || matchesMissionId(item, input.missionId))
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
