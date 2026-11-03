/**
 * Workspace graph — one read model for the entity chain every surface shows:
 * tenant → organization → project → mission → task, plus the work items,
 * approvals and actors attached along it.
 *
 * Surfaces used to read each store separately and never joined them, so a
 * mission was shown without its project, a project without its missions and
 * nobody as the owner of anything. This module joins the stores once, keeps
 * every node's scope fields (tenant / organization / project / tier), and
 * filters per viewer with the shared surface authorization policy. HTTP
 * routes and MCP tools both read it through `surface-operation-registry.ts`.
 *
 * Reads only. Stores stay the source of truth; nothing here is persisted.
 */

import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { listAgentIdentities } from '../agent/agent-identity.js';
import { listApprovalRequests } from '../governance/approval-store-reader.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { listMissionSummaries } from '../mission/mission-read-model.js';
import { loadOrganizationOperationalState } from '../organization/organization-operating-model-persistence.js';
import { listTenantProfileSlugs, readTenantProfile } from '../organization/tenant-registry.js';
import { listMemberIds, readMemberProfile } from '../organization/member-registry.js';
import { findMissionPath, pathResolver } from '../path-resolver.js';
import { missionPathOrNull } from '../mission-lookup.js';
import { readJson } from '../foundation/json.js';
import { listProjectRecords } from '../project/project-registry.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { listWorkItems } from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import {
  authorizeSurfaceOperation,
  type SurfaceAuthorizationContext,
} from './surface-authorization.js';

export const WORKSPACE_GRAPH_READER_ROLE = 'workspace_graph_reader';

export const GRAPH_ENTITY_KINDS = [
  'tenant',
  'organization',
  'project',
  'mission',
  'task',
  'work_item',
  'approval',
  'actor',
] as const;
export type GraphEntityKind = (typeof GRAPH_ENTITY_KINDS)[number];

export interface GraphRef {
  kind: GraphEntityKind;
  id: string;
  label: string;
}

export interface GraphActorLink {
  actorId: string;
  /** The part this actor plays here: owner, assignee, requester, member, agent … */
  role: string;
  /** Display name, when the actor is a known member or agent. */
  label?: string;
}

export interface GraphNode extends GraphRef {
  status?: string;
  tier?: string;
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  missionId?: string;
  summary?: string;
  updatedAt?: string;
  actors?: GraphActorLink[];
  /** Small display facts (counts, kind, priority). Never secrets. */
  facts?: Record<string, string | number | boolean>;
}

export interface WorkspaceGraph {
  generatedAt: string;
  nodes: GraphNode[];
  /** Store reads that failed; the graph is partial, never silently empty. */
  degraded: Array<{ source: string; reason: string }>;
}

export interface MissionTaskRecord {
  task_id: string;
  status?: string;
  description?: string;
  deliverable?: string;
  assigned_to?: { role?: string; actor_id?: string } | string;
}

export interface MissionStaffingRecord {
  actor_id: string;
  team_role: string;
  display_name?: string;
}

/** Injectable store readers: production defaults below, fixtures in tests. */
export interface WorkspaceGraphSources {
  tenants(): Array<{ slug: string; name?: string }>;
  organizations(tenantSlug: string): Array<{
    id: string;
    name: string;
    status?: string;
    tier?: string;
    parentId?: string;
    updatedAt?: string;
  }>;
  projects(): Array<{
    project_id: string;
    name: string;
    summary?: string;
    status?: string;
    tier?: string;
    organization_id?: string;
    tenant_slug?: string;
  }>;
  missions(): Array<{
    id: string;
    status: string;
    tier: string;
    tenantSlug?: string;
    organizationId?: string;
    projectId?: string;
    persona?: string;
    lastEvent?: string;
    /** The human goal; used as the mission's display name. */
    goal?: string;
  }>;
  missionDetail(missionId: string): {
    tasks: MissionTaskRecord[];
    staffing: MissionStaffingRecord[];
    goal?: string;
  };
  workItems(): WorkItem[];
  approvals(): ApprovalRequestRecord[];
  agents(): Array<{
    nhi_id: string;
    display_name: string;
    kind?: string;
    lifecycle_status?: string;
    accountable_human_id?: string;
    affiliation?: {
      organization_id?: string;
      tenant_slug?: string;
      project_id?: string;
      mission_id?: string;
    };
  }>;
  members(): Array<{
    member_id: string;
    display_name: string;
    status?: string;
    memberships: Array<{ tenant_slug: string; role: string }>;
  }>;
}

const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function readJsonObject(file: string): unknown {
  try {
    return safeExistsSync(file) ? readJson<unknown>(file) : undefined;
  } catch {
    return undefined;
  }
}

function asTaskList(value: unknown): MissionTaskRecord[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { tasks?: unknown }).tasks)
      ? (value as { tasks: unknown[] }).tasks
      : [];
  return list.filter(
    (task): task is MissionTaskRecord =>
      Boolean(task) && typeof (task as MissionTaskRecord).task_id === 'string'
  );
}

function asStaffing(value: unknown): MissionStaffingRecord[] {
  const list =
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { assignments?: unknown }).assignments)
      ? (value as { assignments: unknown[] }).assignments
      : [];
  return list.flatMap((entry) => {
    const record = entry as Partial<MissionStaffingRecord> & { actor_display_name?: string };
    if (typeof record.actor_id !== 'string' || typeof record.team_role !== 'string') return [];
    return [
      {
        actor_id: record.actor_id,
        team_role: record.team_role,
        ...(record.display_name || record.actor_display_name
          ? { display_name: record.display_name ?? record.actor_display_name }
          : {}),
      },
    ];
  });
}

const GENERIC_GOAL = /^Deliver mission outcome aligned to /u;

/** The human goal of a mission: the intent summary, else a non-boilerplate requested result. */
export function goalOf(state: unknown): string | undefined {
  const record = state as
    | { intent?: { goal_summary?: unknown }; outcome_contract?: { requested_result?: unknown } }
    | undefined;
  const summary = record?.intent?.goal_summary;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();
  const requested = record?.outcome_contract?.requested_result;
  return typeof requested === 'string' && requested.trim() && !GENERIC_GOAL.test(requested)
    ? requested.trim()
    : undefined;
}

/** Production readers, each run as the read-only graph reader role. */
export function defaultWorkspaceGraphSources(): WorkspaceGraphSources {
  const read = <T>(fn: () => T): T =>
    withExecutionContext(WORKSPACE_GRAPH_READER_ROLE, fn, undefined, '');
  return {
    tenants: () =>
      read(() =>
        listTenantProfileSlugs().map((slug) => {
          let name: string | undefined;
          try {
            const profile = readTenantProfile(slug) as {
              display_name?: string;
              name?: string;
            } | null;
            name = profile?.display_name ?? profile?.name;
          } catch {
            name = undefined;
          }
          return { slug, ...(name ? { name } : {}) };
        })
      ),
    organizations: (tenantSlug) =>
      read(() => {
        const root = path.dirname(
          pathResolver.organizationWorkspaceDir('scope-placeholder', 'confidential', tenantSlug)
        );
        if (!safeExistsSync(root)) return [];
        return safeReaddir(root)
          .filter((id) => ORG_ID.test(id))
          .flatMap((id) => {
            const state = loadOrganizationOperationalState(id, {
              tier: 'confidential',
              tenantSlug,
            });
            return [
              {
                id,
                name: state?.name || id,
                ...(state?.status ? { status: state.status } : {}),
                tier: 'confidential',
                ...(state?.parent_organization_id
                  ? { parentId: state.parent_organization_id }
                  : {}),
                ...(state?.updated_at ? { updatedAt: state.updated_at } : {}),
              },
            ];
          });
      }),
    projects: () => read(() => listProjectRecords()),
    missions: () =>
      read(() =>
        listMissionSummaries().map((summary) => {
          const dir = missionPathOrNull(findMissionPath, summary.id);
          const goal = dir
            ? goalOf(readJsonObject(path.join(dir, 'mission-state.json')))
            : undefined;
          return goal ? { ...summary, goal } : summary;
        })
      ),
    missionDetail: (missionId) =>
      read(() => {
        const dir = missionPathOrNull(findMissionPath, missionId);
        if (!dir) return { tasks: [], staffing: [] };
        const goal = goalOf(readJsonObject(path.join(dir, 'mission-state.json')));
        return {
          tasks: asTaskList(readJsonObject(path.join(dir, 'NEXT_TASKS.json'))),
          staffing: asStaffing(readJsonObject(path.join(dir, 'staffing-assignments.json'))),
          ...(goal ? { goal } : {}),
        };
      }),
    workItems: () => read(() => listWorkItems()),
    approvals: () => read(() => listApprovalRequests()),
    agents: () => read(() => listAgentIdentities()),
    members: () =>
      read(() =>
        listMemberIds().flatMap((id) => {
          const profile = readMemberProfile(id);
          return profile
            ? [
                {
                  member_id: profile.member_id,
                  display_name: profile.display_name,
                  status: profile.status,
                  memberships: profile.memberships.map((m) => ({
                    tenant_slug: m.tenant_slug,
                    role: m.role,
                  })),
                },
              ]
            : [];
        })
      ),
  };
}

function approvalScope(record: ApprovalRequestRecord): {
  tenantSlug?: string;
  missionId?: string;
} {
  const context = record.requestedByContext as
    | { tenant_slug?: string; tenantSlug?: string; missionId?: string; mission_id?: string }
    | undefined;
  const loose = record as unknown as {
    scope?: { tenant_slug?: string };
    work_loop?: { context?: { tenant_slug?: unknown; mission_id?: unknown } };
  };
  const loop = loose.work_loop?.context;
  const tenantSlug =
    loose.scope?.tenant_slug ||
    context?.tenant_slug ||
    context?.tenantSlug ||
    (typeof loop?.tenant_slug === 'string' ? loop.tenant_slug : undefined);
  const missionId =
    context?.missionId ||
    context?.mission_id ||
    record.steering?.missionId ||
    (typeof loop?.mission_id === 'string' ? loop.mission_id : undefined);
  return { ...(tenantSlug ? { tenantSlug } : {}), ...(missionId ? { missionId } : {}) };
}

function workItemScope(item: WorkItem) {
  const context = item.context as
    | {
        tenant_slug?: string;
        organization_id?: string;
        project_id?: string;
        mission_id?: string;
        tier?: string;
      }
    | undefined;
  return {
    tenantSlug: context?.tenant_slug,
    organizationId: context?.organization_id,
    projectId: context?.project_id || item.project_id || undefined,
    missionId: context?.mission_id,
    tier: context?.tier,
  };
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== '')
  ) as T;
}

/**
 * Join every store into one node list. Each source is read independently: a
 * failing store is reported in `degraded` and the rest of the graph remains.
 */
export function collectWorkspaceGraph(
  sources: WorkspaceGraphSources = defaultWorkspaceGraphSources(),
  now: () => Date = () => new Date()
): WorkspaceGraph {
  const degraded: WorkspaceGraph['degraded'] = [];
  const attempt = <T>(source: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (error) {
      degraded.push({ source, reason: error instanceof Error ? error.message : String(error) });
      return fallback;
    }
  };
  const nodes = new Map<string, GraphNode>();
  const key = (kind: GraphEntityKind, id: string) => `${kind}:${id}`;
  const put = (node: GraphNode) => {
    const existing = nodes.get(key(node.kind, node.id));
    nodes.set(
      key(node.kind, node.id),
      existing ? { ...node, ...compact(existing) } : compact(node)
    );
  };

  const tenants = attempt('tenants', () => sources.tenants(), []);
  for (const tenant of tenants) {
    put({
      kind: 'tenant',
      id: tenant.slug,
      label: tenant.name || tenant.slug,
      tenantSlug: tenant.slug,
      tier: 'confidential',
    });
    for (const org of attempt(
      `organizations:${tenant.slug}`,
      () => sources.organizations(tenant.slug),
      []
    )) {
      put({
        kind: 'organization',
        id: org.id,
        label: org.name,
        status: org.status,
        tier: org.tier ?? 'confidential',
        tenantSlug: tenant.slug,
        organizationId: org.id,
        updatedAt: org.updatedAt,
        ...(org.parentId ? { facts: { parent_organization_id: org.parentId } } : {}),
      });
    }
  }

  for (const project of attempt('projects', () => sources.projects(), [])) {
    put({
      kind: 'project',
      id: project.project_id,
      label: project.name || project.project_id,
      summary: project.summary,
      status: project.status,
      tier: project.tier,
      tenantSlug: project.tenant_slug,
      organizationId: project.organization_id,
      projectId: project.project_id,
    });
  }

  for (const mission of attempt('missions', () => sources.missions(), [])) {
    put({
      kind: 'mission',
      id: mission.id,
      label: mission.goal || mission.id,
      status: mission.status,
      tier: mission.tier,
      tenantSlug: mission.tenantSlug,
      organizationId: mission.organizationId,
      projectId: mission.projectId,
      missionId: mission.id,
      ...(mission.persona || mission.lastEvent
        ? {
            facts: {
              ...(mission.persona ? { persona: mission.persona } : {}),
              ...(mission.lastEvent ? { last_event: mission.lastEvent } : {}),
            },
          }
        : {}),
    });
  }

  for (const item of attempt('work_items', () => sources.workItems(), [])) {
    const scope = workItemScope(item);
    const actors: GraphActorLink[] = [];
    const assignee = item.assignee_user_id || item.assignee_peer_id;
    if (assignee) actors.push({ actorId: assignee, role: 'assignee' });
    const holder = item.claimed_by_user_id || item.claimed_by_peer_id;
    if (holder && holder !== assignee) actors.push({ actorId: holder, role: 'claim_holder' });
    put({
      kind: 'work_item',
      id: item.item_id,
      label: item.title || item.item_id,
      summary: item.description,
      status: item.status,
      updatedAt: item.updated_at,
      ...scope,
      ...(actors.length ? { actors } : {}),
      facts: { priority: item.priority, source: item.source },
    });
  }

  for (const approval of attempt('approvals', () => sources.approvals(), [])) {
    const scope = approvalScope(approval);
    const mission = scope.missionId ? nodes.get(key('mission', scope.missionId)) : undefined;
    put({
      kind: 'approval',
      id: approval.id,
      label: approval.title || approval.subject || approval.id,
      summary: approval.summary,
      status: approval.status,
      updatedAt: approval.decidedAt || approval.requestedAt,
      tenantSlug: scope.tenantSlug ?? mission?.tenantSlug,
      organizationId: mission?.organizationId,
      projectId: mission?.projectId,
      missionId: scope.missionId,
      tier: mission?.tier,
      actors: [
        { actorId: approval.requestedBy, role: 'requester' },
        ...(approval.decidedBy ? [{ actorId: approval.decidedBy, role: 'decider' }] : []),
      ],
      facts: { approval_kind: approval.kind, channel: approval.channel },
    });
  }

  for (const agent of attempt('agents', () => sources.agents(), [])) {
    const affiliation = agent.affiliation ?? {};
    put({
      kind: 'actor',
      id: agent.nhi_id,
      label: agent.display_name || agent.nhi_id,
      status: agent.lifecycle_status,
      tenantSlug: affiliation.tenant_slug,
      organizationId: affiliation.organization_id,
      projectId: affiliation.project_id,
      missionId: affiliation.mission_id,
      tier: affiliation.tenant_slug ? 'confidential' : 'public',
      facts: { actor_type: 'agent', ...(agent.kind ? { agent_kind: agent.kind } : {}) },
      ...(agent.accountable_human_id
        ? { actors: [{ actorId: agent.accountable_human_id, role: 'accountable_human' }] }
        : {}),
    });
  }

  for (const member of attempt('members', () => sources.members(), [])) {
    // A member belongs to tenants, not one organization: one node per tenant
    // membership would duplicate ids, so the node carries the first tenant
    // and `facts.tenants` lists them all for filtering.
    const tenantsOfMember = member.memberships.map((m) => m.tenant_slug);
    put({
      kind: 'actor',
      id: member.member_id,
      label: member.display_name || member.member_id,
      status: member.status,
      tenantSlug: tenantsOfMember.length === 1 ? tenantsOfMember[0] : undefined,
      tier: 'confidential',
      facts: {
        actor_type: 'member',
        tenants: tenantsOfMember.join(','),
        roles: member.memberships.map((m) => `${m.tenant_slug}:${m.role}`).join(','),
      },
    });
  }

  // Actor chips read as people, not ids: label every link whose actor is known.
  const actorLabels = new Map(
    [...nodes.values()].filter((n) => n.kind === 'actor').map((n) => [n.id, n.label])
  );
  for (const node of nodes.values()) {
    if (!node.actors) continue;
    node.actors = node.actors.map((link) =>
      actorLabels.has(link.actorId) ? { ...link, label: actorLabels.get(link.actorId)! } : link
    );
  }
  return { generatedAt: now().toISOString(), nodes: [...nodes.values()], degraded };
}

const GRAPH_READ_POLICY = {
  operationId: 'workspace.graph.read',
  effect: 'read' as const,
  requiredPermissions: ['surface.headless.read' as const],
};

/**
 * Row-level admission. A node with no tenant is system data: only a viewer
 * scoped to every tenant sees it, unless it is public tier.
 */
export function viewerAdmitsNode(viewer: SurfaceAuthorizationContext, node: GraphNode): boolean {
  if (node.kind === 'actor' && node.facts?.actor_type === 'member') {
    const memberTenants = String(node.facts.tenants || '')
      .split(',')
      .filter(Boolean);
    if (viewer.tenantSlugs === 'all') return true;
    return memberTenants.some((tenant) => viewer.tenantSlugs.includes(tenant));
  }
  if (!node.tenantSlug && node.tier !== 'public' && viewer.tenantSlugs !== 'all') return false;
  return authorizeSurfaceOperation({
    context: viewer,
    operation: GRAPH_READ_POLICY,
    resource: {
      ...(node.tenantSlug ? { tenantSlug: node.tenantSlug } : {}),
      ...(node.organizationId && node.kind !== 'actor'
        ? { organizationId: node.organizationId }
        : {}),
      ...(node.projectId && ['project', 'mission', 'task', 'work_item'].includes(node.kind)
        ? { projectId: node.projectId }
        : {}),
      ...(node.tier ? { tier: node.tier } : {}),
    },
  }).allowed;
}

export function filterWorkspaceGraph(
  graph: WorkspaceGraph,
  viewer: SurfaceAuthorizationContext
): WorkspaceGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => viewerAdmitsNode(viewer, node)),
    // A scoped viewer must not learn other tenants' store failures.
    degraded:
      viewer.tenantSlugs === 'all'
        ? graph.degraded
        : graph.degraded.map((d) => ({ source: d.source.split(':')[0]!, reason: 'unavailable' })),
  };
}

export interface GraphListFilter {
  kind?: GraphEntityKind;
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  missionId?: string;
  actorId?: string;
  status?: string;
  q?: string;
  limit?: number;
}

function matchesQuery(node: GraphNode, q: string): boolean {
  const needle = q.toLowerCase();
  return [node.id, node.label, node.summary, node.status]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export function listGraphNodes(graph: WorkspaceGraph, filter: GraphListFilter = {}): GraphNode[] {
  const result = graph.nodes.filter(
    (node) =>
      (!filter.kind || node.kind === filter.kind) &&
      (!filter.tenantSlug ||
        node.tenantSlug === filter.tenantSlug ||
        String(node.facts?.tenants ?? '')
          .split(',')
          .includes(filter.tenantSlug)) &&
      (!filter.organizationId || node.organizationId === filter.organizationId) &&
      (!filter.projectId || node.projectId === filter.projectId) &&
      (!filter.missionId || node.missionId === filter.missionId) &&
      (!filter.actorId || node.actors?.some((a) => a.actorId === filter.actorId)) &&
      (!filter.status || node.status === filter.status) &&
      (!filter.q || matchesQuery(node, filter.q))
  );
  result.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return result.slice(0, Math.max(1, Math.min(filter.limit ?? 200, 500)));
}

export interface GraphEntityView {
  node: GraphNode;
  /** tenant › organization › project › mission, outermost first, excluding the node. */
  lineage: GraphRef[];
  /** Directly contained entities, grouped by kind. */
  children: Partial<Record<GraphEntityKind, GraphNode[]>>;
  /** Actors involved, resolved to nodes when known. */
  actors: Array<GraphActorLink & { label: string; known: boolean }>;
  /** For actors: what they are involved in. */
  involvements?: GraphNode[];
  goal?: string;
}

function ref(node: GraphNode): GraphRef {
  return { kind: node.kind, id: node.id, label: node.label };
}

export function getGraphEntity(
  graph: WorkspaceGraph,
  kind: GraphEntityKind,
  id: string,
  sources?: Pick<WorkspaceGraphSources, 'missionDetail'>
): GraphEntityView | null {
  const find = (k: GraphEntityKind, i: string | undefined) =>
    i ? graph.nodes.find((n) => n.kind === k && n.id === i) : undefined;
  const node = find(kind, id);
  if (!node) return null;

  const lineage: GraphRef[] = [];
  const chain: Array<[GraphEntityKind, string | undefined]> = [
    ['tenant', node.tenantSlug],
    ['organization', node.organizationId],
    ['project', node.projectId],
    ['mission', node.missionId],
  ];
  for (const [k, i] of chain) {
    if (!i || (k === node.kind && i === node.id)) continue;
    const parent = find(k, i);
    // An unknown parent is still shown (as its id) so the chain never breaks.
    lineage.push(parent ? ref(parent) : { kind: k, id: i, label: i });
  }

  const children: GraphEntityView['children'] = {};
  const add = (child: GraphNode) => {
    (children[child.kind] ??= []).push(child);
  };
  for (const other of graph.nodes) {
    if (other === node) continue;
    if (node.kind === 'tenant' && other.tenantSlug === node.id && other.kind === 'organization')
      add(other);
    if (
      node.kind === 'tenant' &&
      other.tenantSlug === node.id &&
      other.kind === 'project' &&
      !other.organizationId
    )
      add(other);
    if (
      node.kind === 'organization' &&
      other.organizationId === node.id &&
      other.tenantSlug === node.tenantSlug
    ) {
      if (['project', 'actor'].includes(other.kind)) add(other);
      if (other.kind === 'mission' && !other.projectId) add(other);
    }
    if (
      node.kind === 'project' &&
      other.projectId === node.id &&
      ['mission', 'work_item', 'actor'].includes(other.kind)
    ) {
      if (other.kind !== 'work_item' || !other.missionId) add(other);
    }
    if (
      node.kind === 'mission' &&
      other.missionId === node.id &&
      ['work_item', 'approval', 'actor'].includes(other.kind)
    )
      add(other);
  }

  const actorLinks: GraphActorLink[] = [...(node.actors ?? [])];
  let goal: string | undefined;
  if (node.kind === 'mission' && sources) {
    const detail = sources.missionDetail(node.id);
    goal = detail.goal;
    children.task = detail.tasks.map((task) => ({
      kind: 'task' as const,
      id: `${node.id}/${task.task_id}`,
      label: task.description || task.task_id,
      status: task.status,
      tenantSlug: node.tenantSlug,
      organizationId: node.organizationId,
      projectId: node.projectId,
      missionId: node.id,
      tier: node.tier,
      facts: {
        task_id: task.task_id,
        ...(task.deliverable ? { deliverable: task.deliverable } : {}),
        ...(typeof task.assigned_to === 'object' && task.assigned_to?.role
          ? { assigned_role: task.assigned_to.role }
          : {}),
      },
    }));
    for (const staff of detail.staffing)
      actorLinks.push({ actorId: staff.actor_id, role: staff.team_role });
  }
  if (node.kind === 'mission' && node.facts?.persona) {
    actorLinks.push({ actorId: String(node.facts.persona), role: 'persona' });
  }
  for (const child of children.actor ?? [])
    actorLinks.push({ actorId: child.id, role: 'affiliated' });

  const seen = new Set<string>();
  const actors = actorLinks
    .filter((link) => {
      const k = `${link.actorId}:${link.role}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((link) => {
      // Staffing names an agent by its profile slug; the identity ledger by
      // its full ActorRef (kyberion://agent/<org>/<slug>). Either resolves.
      const actor =
        find('actor', link.actorId) ??
        graph.nodes.find(
          (n) =>
            n.kind === 'actor' &&
            n.id.startsWith('kyberion://agent/') &&
            n.id.endsWith(`/${link.actorId}`)
        );
      return {
        ...link,
        ...(actor ? { actorId: actor.id } : {}),
        label: actor?.label ?? link.actorId,
        known: Boolean(actor),
      };
    });

  const view: GraphEntityView = { node, lineage, children, actors };
  if (goal) view.goal = goal;
  if (node.kind === 'actor') {
    view.involvements = graph.nodes.filter(
      (other) =>
        other.actors?.some((a) => a.actorId === node.id) ||
        (other.kind === 'mission' && node.missionId === other.id) ||
        (other.kind === 'project' && node.projectId === other.id && !node.missionId)
    );
  }
  return view;
}

export interface WorkspaceGraphSummary {
  generatedAt: string;
  counts: Record<GraphEntityKind, number>;
  /** Open work that needs a human: pending approvals and blocked/failed items. */
  attention: GraphNode[];
  tenants: Array<GraphRef & { organizations: Array<GraphRef & { projects: GraphRef[] }> }>;
  degraded: WorkspaceGraph['degraded'];
}

const ATTENTION_STATUSES = new Set(['pending', 'blocked', 'failed', 'needs_review']);

export function summarizeWorkspaceGraph(graph: WorkspaceGraph): WorkspaceGraphSummary {
  const counts = Object.fromEntries(GRAPH_ENTITY_KINDS.map((k) => [k, 0])) as Record<
    GraphEntityKind,
    number
  >;
  for (const node of graph.nodes) counts[node.kind] += 1;
  const tenants = graph.nodes
    .filter((n) => n.kind === 'tenant')
    .map((tenant) => ({
      ...ref(tenant),
      organizations: graph.nodes
        .filter((n) => n.kind === 'organization' && n.tenantSlug === tenant.id)
        .map((org) => ({
          ...ref(org),
          projects: graph.nodes
            .filter(
              (n) =>
                n.kind === 'project' && n.organizationId === org.id && n.tenantSlug === tenant.id
            )
            .map(ref),
        })),
    }));
  const attention = graph.nodes
    .filter(
      (n) =>
        (n.kind === 'approval' || n.kind === 'work_item') &&
        ATTENTION_STATUSES.has(String(n.status))
    )
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 50);
  return { generatedAt: graph.generatedAt, counts, attention, tenants, degraded: graph.degraded };
}
