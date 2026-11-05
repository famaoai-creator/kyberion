/**
 * Pure helpers for the Concierge workspace pages (`/w`, `/w/<kind>`,
 * `/w/<kind>/<id>`): entity hrefs, `/api/v1/workspace/*` request paths,
 * lineage crumbs and status filters. The read model itself lives in
 * `libs/core/surface/workspace-graph.ts`; only its types are imported here,
 * so this module stays client-safe.
 */
import { iaListHref } from './ia-routes';
import type {
  GraphActorLink,
  GraphEntityKind,
  GraphEntityView,
  GraphNode,
  GraphRef,
  WorkspaceGraphSummary,
} from '@agent/core/surface/workspace-graph';
import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';

export type {
  GraphActorLink,
  GraphEntityKind,
  GraphEntityView,
  GraphNode,
  GraphRef,
  WorkspaceGraphSummary,
};

/** Kinds in containment order; mirrors `GRAPH_ENTITY_KINDS` without importing runtime code. */
export const WORKSPACE_KINDS: readonly GraphEntityKind[] = [
  'tenant',
  'organization',
  'project',
  'mission',
  'task',
  'work_item',
  'approval',
  'actor',
];

export function isWorkspaceKind(value: unknown): value is GraphEntityKind {
  return typeof value === 'string' && (WORKSPACE_KINDS as readonly string[]).includes(value);
}

/** `/w/<kind>/<id>`; ids are one encoded segment (task ids contain `/`). */
export function entityHref(kind: GraphEntityKind, id: string): string {
  return `/w/${kind}/${encodeURIComponent(id)}`;
}

/** A list page, optionally narrowed by scope query parameters. */
export function kindListHref(kind: GraphEntityKind, narrow: WorkspaceListNarrowing = {}): string {
  // MSN-SHELL-IA §1: list pages live under the top-level destinations now
  // (`/w/<kind>` only redirects there), so in-app links point straight at them.
  const [path, fixed = ''] = (iaListHref(kind) ?? `/w/${kind}`).split('?');
  const query = new URLSearchParams(fixed);
  for (const [key, value] of Object.entries(narrow)) if (value) query.set(key, value);
  const search = query.toString();
  return `${path}${search ? `?${search}` : ''}`;
}

/** Route segments may arrive encoded or decoded depending on the router; decode once, safely. */
export function decodeRouteSegment(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join('/') : (value ?? '');
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface WorkspaceListNarrowing {
  tenant?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  actor_id?: string;
}

export interface WorkspaceListQuery extends WorkspaceListNarrowing {
  q?: string;
  status?: string;
}

const NARROWING_KEYS = [
  'tenant',
  'organization_id',
  'project_id',
  'mission_id',
  'actor_id',
] as const;
/** The rail writes camelCase scope hints on Concierge hrefs; the API takes snake_case. */
const CAMEL_ALIASES: Record<string, (typeof NARROWING_KEYS)[number]> = {
  organizationId: 'organization_id',
  projectId: 'project_id',
  missionId: 'mission_id',
  actorId: 'actor_id',
};

/**
 * Page URL → list query. Only the parameters the operation accepts survive
 * (the API rejects unknown fields), and the rail's `personal` / `shared`
 * selections are views, not tenants, so they never become a tenant filter.
 */
export function listQueryFromSearch(params: URLSearchParams): WorkspaceListQuery {
  const query: WorkspaceListQuery = {};
  for (const key of NARROWING_KEYS) {
    const value = params.get(key)?.trim();
    if (value) query[key] = value;
  }
  for (const [alias, key] of Object.entries(CAMEL_ALIASES)) {
    const value = params.get(alias)?.trim();
    if (value && !query[key]) query[key] = value;
  }
  if (query.tenant === PERSONAL_SELECTION || query.tenant === SYSTEM_SELECTION) delete query.tenant;
  const q = params.get('q')?.trim();
  if (q) query.q = q.slice(0, 200);
  const status = params.get('status')?.trim();
  if (status) query.status = status;
  return query;
}

/** `/api/v1/workspace/<verb>?…` with only defined, non-empty parameters. */
export function workspaceApiPath(
  verb: 'summary' | 'list' | 'get' | 'search',
  params: Record<string, string | number | undefined> = {}
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.toString();
  return `/api/v1/workspace/${verb}${search ? `?${search}` : ''}`;
}

/**
 * Narrowing parameters that are scope (not text/status), as refs the page
 * can name: the user must always see why a list is shorter than expected.
 */
export function narrowingEntries(
  query: WorkspaceListQuery
): Array<{ kind: GraphEntityKind; id: string }> {
  const kinds: Record<(typeof NARROWING_KEYS)[number], GraphEntityKind> = {
    tenant: 'tenant',
    organization_id: 'organization',
    project_id: 'project',
    mission_id: 'mission',
    actor_id: 'actor',
  };
  return NARROWING_KEYS.filter((key) => query[key]).map((key) => ({
    kind: kinds[key],
    id: query[key]!,
  }));
}

/**
 * Lineage of a list row from its scope fields (tenant › organization ›
 * project › mission), excluding the node itself. Labels fall back to ids;
 * `labels` resolves known ids (e.g. from the overview tree).
 */
export function nodeLineage(
  node: GraphNode,
  labels: ReadonlyMap<string, string> = new Map()
): GraphRef[] {
  const chain: Array<[GraphEntityKind, string | undefined]> = [
    ['tenant', node.tenantSlug],
    ['organization', node.organizationId],
    ['project', node.projectId],
    ['mission', node.missionId],
  ];
  return chain.flatMap(([kind, id]) =>
    !id || (kind === node.kind && id === node.id)
      ? []
      : [{ kind, id, label: labels.get(`${kind}:${id}`) ?? id }]
  );
}

/** `kind:id` → label for every ref of a workspace summary tree. */
export function summaryLabelIndex(summary: WorkspaceGraphSummary | null): Map<string, string> {
  const index = new Map<string, string>();
  for (const tenant of summary?.tenants ?? []) {
    index.set(`tenant:${tenant.id}`, tenant.label);
    for (const org of tenant.organizations) {
      index.set(`organization:${org.id}`, org.label);
      for (const project of org.projects) index.set(`project:${project.id}`, project.label);
    }
  }
  return index;
}

/** Distinct statuses in first-seen order, with counts, for filter chips. */
export function statusFacets(
  items: readonly GraphNode[]
): Array<{ status: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.status) continue;
    counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  }
  return [...counts].map(([status, count]) => ({ status, count }));
}

/** Kinds an entity of `kind` can contain, so an empty one can say what would go there. */
export const CONTAINABLE_KINDS: Readonly<Record<GraphEntityKind, readonly GraphEntityKind[]>> = {
  tenant: ['organization', 'project'],
  organization: ['project', 'mission', 'actor'],
  project: ['mission', 'work_item', 'actor'],
  mission: ['task', 'work_item', 'approval', 'actor'],
  task: [],
  work_item: [],
  approval: [],
  actor: [],
};

/** Statuses that mean an approval still needs a person's decision. */
export function approvalNeedsDecision(status: string | undefined): boolean {
  return status === 'pending' || status === 'needs_review';
}

/** The card of a pending approval in あなた待ち (`/inbox`, the one needs-you queue). */
export { inboxHrefForApproval } from './inbox-links';

export type WorkspaceLoadError = 'signin' | 'forbidden' | 'not_found' | 'failed';

export function loadErrorFromStatus(status: number): WorkspaceLoadError {
  if (status === 401) return 'signin';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'failed';
}

/** Distinct degraded source names (store failures are reported, never hidden). */
export function degradedSources(degraded: ReadonlyArray<{ source: string }> | undefined): string[] {
  return [...new Set((degraded ?? []).map((entry) => entry.source.split(':')[0]!))];
}
