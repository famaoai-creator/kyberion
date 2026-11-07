import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Custody admission contract (P4 — one rule: `admitsCustody`).
 *
 * Three viewer custody kinds, one shared fixture, every viewer-scoped reader:
 *
 *   - system viewer   `{ tenantSlugs: [], includeUntenanted: true }`
 *   - tenant viewer   `{ tenantSlugs: ['acme'] }`
 *   - person viewer   `{ tenantSlugs: [], memberId/principalId = the owner }`
 *
 * Readers under contract:
 *
 *   - `readConciergeHome`     (home — approval queue)
 *   - `collectHomeDashboard`  (home — missions, deliverables)
 *   - `readConciergeNeedsYou` (awaiting — shell reader)
 *   - `readNeedsYouSources`   (awaiting — MCP default reader)
 *   - `viewerAdmitsNode`      (graph — row admission for workspace nodes)
 *
 * A person-custody record (`scope.owner_nhi`, untenanted, personal tier)
 * admits to its owner only — never via `tenantSlugs`, not even `'all'`.
 * The tier ceiling is held identical across viewers so the ONLY difference
 * in what each sees is custody.
 */

const fixture = vi.hoisted(() => {
  const at = '2026-11-05T10:00:00.000Z';
  const approval = (id: string, tenant?: string, scopeExtra?: object) => ({
    id,
    kind: 'mission_gate',
    channel: 'external-operation',
    storageChannel: 'external-operation',
    title: `Approval required: ${id}`,
    summary: '',
    status: 'pending',
    requestedBy: 'agent:planner',
    requestedAt: at,
    scope: { tier: 'confidential', ...(tenant ? { tenant_slug: tenant } : {}), ...scopeExtra },
  });
  const inbox = (id: string, tenant?: string) => ({
    entry_id: id,
    title: `Outcome ${id}`,
    summary: '',
    artifact_paths: [],
    status: 'unread',
    updated_at: at,
    created_at: at,
    ...(tenant ? { tenant_slug: tenant } : {}),
  });
  const mission = (id: string, tenant?: string) => ({
    mission_id: id,
    status: 'paused',
    tier: 'confidential',
    ...(tenant ? { tenant_slug: tenant } : {}),
    history: [{ ts: at, event: 'start' }],
  });
  const artifact = (id: string, tenant?: string) => ({
    artifact_id: id,
    kind: 'report',
    storage_class: 'repo',
    metadata: { tier: 'confidential' },
    ...(tenant ? { tenant_slug: tenant } : {}),
  });
  return {
    approvals: [
      approval('AP-ACME', 'acme'),
      approval('AP-BETA', 'beta'),
      approval('AP-SYS'),
      // Person custody: owner-bound, non-personal tier — the tier ceiling
      // passes for every viewer, so custody alone decides who sees it.
      approval('AP-PER', undefined, { owner_nhi: 'human:owner' }),
      // Person custody owned by someone else — no viewer below may see it.
      approval('AP-OTH', undefined, { owner_nhi: 'human:other' }),
      // Public tier + owner binding: person custody is never broadcast, not
      // even to the system view — the tier ceiling passes but custody decides.
      approval('AP-PUBPER', undefined, { tier: 'public', owner_nhi: 'human:owner' }),
    ],
    inbox: [inbox('IN-ACME', 'acme'), inbox('IN-BETA', 'beta'), inbox('IN-SYS')],
    missions: [mission('MSN-ACME', 'acme'), mission('MSN-BETA', 'beta'), mission('MSN-SYS')],
    artifacts: [artifact('ART-ACME', 'acme'), artifact('ART-BETA', 'beta'), artifact('ART-SYS')],
    // Workspace-graph nodes: two tenant missions, one system node, one public
    // node, and two member actors bound to different tenants.
    graphNodes: [
      {
        kind: 'mission',
        id: 'MSN-ACME',
        label: 'Acme mission',
        status: 'active',
        tenantSlug: 'acme',
        tier: 'confidential',
        facts: {},
      },
      {
        kind: 'mission',
        id: 'MSN-BETA',
        label: 'Beta mission',
        status: 'active',
        tenantSlug: 'beta',
        tier: 'confidential',
        facts: {},
      },
      {
        kind: 'mission',
        id: 'MSN-SYS',
        label: 'System mission',
        status: 'active',
        tier: 'confidential',
        facts: {},
      },
      {
        kind: 'project',
        id: 'PUB-SYS',
        label: 'Public note',
        status: 'active',
        tier: 'public',
        facts: {},
      },
      {
        kind: 'actor',
        id: 'member-alice',
        label: 'Alice',
        status: 'active',
        tier: 'confidential',
        facts: { actor_type: 'member', tenants: 'acme' },
      },
      {
        kind: 'actor',
        id: 'member-owner',
        label: 'Owner',
        status: 'active',
        tier: 'confidential',
        facts: { actor_type: 'member', tenants: 'beta' },
      },
    ],
  };
});

vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
  listApprovalRequests: () => fixture.approvals.map((record) => structuredClone(record)),
}));
vi.mock('@agent/core/governance/approval-store-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store-reader')>()),
  listApprovalRequests: () => fixture.approvals.map((record) => structuredClone(record)),
}));
vi.mock('@agent/core/deliverable-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/deliverable-inbox')>()),
  listInboxEntries: () => fixture.inbox.map((entry) => structuredClone(entry)),
}));
vi.mock('@agent/core/workforce/artifact-record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/workforce/artifact-record')>()),
  listArtifactRecords: () => fixture.artifacts.map((record) => structuredClone(record)),
}));
vi.mock('@agent/core/mission/mission-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/mission/mission-state')>()),
  listMissionsInSearchDirs: () => fixture.missions.map((m) => ({ missionId: m.mission_id })),
  loadState: (missionId: string) =>
    structuredClone(fixture.missions.find((m) => m.mission_id === missionId)) ?? null,
}));
vi.mock('@agent/core/agent/agent-activity-board', () => ({
  buildAgentActivityBoard: () => ({ entries: [] }),
}));
vi.mock('@agent/core/surface/surface-ux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/surface-ux')>()),
  listSurfaceNotificationsAcrossChannels: () => [],
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/memory-promotion-queue')>()),
  listMemoryPromotionCandidates: () => [],
}));
vi.mock('@agent/core/mission/mission-hygiene', () => ({
  collectMissionHygieneReport: () => ({ abandoned: [], stale: [] }),
}));

import { readNeedsYouSources } from '@agent/core/surface/needs-you-sources';
import { viewerAdmitsNode } from '@agent/core/surface/workspace-graph';
import type { GraphNode } from '@agent/core/surface/workspace-graph';
import { readConciergeHome } from '../presence/displays/concierge/src/lib/headless-projections';
import { collectHomeDashboard } from '../presence/displays/concierge/src/lib/home-dashboard';
import { readConciergeNeedsYou } from '../presence/displays/concierge/src/lib/needs-you-server';
import { toSurfaceAuthorizationContext } from '../presence/displays/concierge/src/lib/viewer-context';
import type { ConciergeViewerContext } from '../presence/displays/concierge/src/lib/viewer-context';

function viewer(scope: Partial<ConciergeViewerContext>): ConciergeViewerContext {
  return {
    role: 'localadmin',
    tenantSlugs: [],
    organizationIds: 'all',
    projectIds: 'all',
    // Identical tier ceilings for every viewer — the only variable is custody.
    tierAccess: ['personal', 'confidential', 'public'],
    source: 'token',
    principalId: 'human:nobody',
    ...scope,
  } as ConciergeViewerContext;
}

const SYSTEM = viewer({ tenantSlugs: [], includeUntenanted: true, principalId: 'human:system' });
const ACME = viewer({ tenantSlugs: ['acme'], principalId: 'human:acme' });
const ALL = viewer({ tenantSlugs: 'all', principalId: 'human:all' });
// The person viewer: no tenant scope; its own identity is member-owner /
// human:owner. It may see only its own person-custody rows.
const PERSON = viewer({
  tenantSlugs: [],
  memberId: 'member-owner',
  principalId: 'human:owner',
});

const suffixes = (ids: string[]) =>
  [...new Set(ids.map((id) => id.replace(/^.*-(ACME|BETA|SYS|PER|OTH|PUBPER)$/, '$1')))].sort();

function admitted(view: ConciergeViewerContext) {
  const home = readConciergeHome(view, { limit: 50 });
  const dashboard = collectHomeDashboard(view as never, Date.parse('2026-11-05T12:00:00Z'));
  const shell = readConciergeNeedsYou(view);
  const mcp = readNeedsYouSources(toSurfaceAuthorizationContext(view));
  const graph = fixture.graphNodes.filter((node) =>
    viewerAdmitsNode(toSurfaceAuthorizationContext(view), node as GraphNode)
  );
  return {
    'readConciergeHome approvals': suffixes(home.approval_queue.map((item) => item.id)),
    'collectHomeDashboard missions': suffixes(dashboard.missions.blocked.map((m) => m.id)),
    'collectHomeDashboard deliverables': suffixes(dashboard.deliverables.map((d) => d.id)),
    'needs-you (shell) approvals': suffixes(
      shell.approvals.map((item) => item.id.replace(/^approval:[^/]+\//, ''))
    ),
    'needs-you (MCP) approvals': suffixes(mcp.approvals.map((item) => item.id)),
    'needs-you (MCP) outcomes': suffixes(mcp.outcomes.map((item) => item.entry_id)),
    'workspace-graph nodes': graph.map((n) => `${n.kind}:${n.id}`).sort(),
  };
}

describe('custody admission is one rule across viewer-scoped readers (P4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the system viewer sees only company-less records, in every reader', () => {
    const result = admitted(SYSTEM);
    expect(result['readConciergeHome approvals']).toEqual(['SYS']);
    expect(result['collectHomeDashboard missions']).toEqual(['SYS']);
    expect(result['collectHomeDashboard deliverables']).toEqual(['SYS']);
    expect(result['needs-you (shell) approvals']).toEqual(['SYS']);
    expect(result['needs-you (MCP) approvals']).toEqual(['SYS']);
    expect(result['needs-you (MCP) outcomes']).toEqual(['SYS']);
    // Graph: system mission + the public broadcast node; no member nodes.
    expect(result['workspace-graph nodes']).toEqual(['mission:MSN-SYS', 'project:PUB-SYS']);
  });

  it('the single-tenant viewer sees its own records only — never system or person rows', () => {
    const result = admitted(ACME);
    expect(result['readConciergeHome approvals']).toEqual(['ACME']);
    expect(result['collectHomeDashboard missions']).toEqual(['ACME']);
    expect(result['collectHomeDashboard deliverables']).toEqual(['ACME']);
    expect(result['needs-you (shell) approvals']).toEqual(['ACME']);
    expect(result['needs-you (MCP) approvals']).toEqual(['ACME']);
    expect(result['needs-you (MCP) outcomes']).toEqual(['ACME']);
    // Graph: its mission, the public node, and the member bound to its tenant.
    expect(result['workspace-graph nodes'].sort()).toEqual([
      'actor:member-alice',
      'mission:MSN-ACME',
      'project:PUB-SYS',
    ]);
  });

  it('the person viewer sees only its own person-custody records, in every reader', () => {
    const result = admitted(PERSON);
    // Home: owner-bound approvals admit to their owner through custody —
    // person rows only, public-owner included.
    expect(result['readConciergeHome approvals']).toEqual(['PER', 'PUBPER']);
    expect(result['collectHomeDashboard missions']).toEqual([]);
    expect(result['collectHomeDashboard deliverables']).toEqual([]);
    // Awaiting: custody admits the owner-bound approvals to their owner
    // only — the same answer in the shell reader and the MCP default reader.
    expect(result['needs-you (shell) approvals']).toEqual(['PER', 'PUBPER']);
    expect(result['needs-you (MCP) approvals']).toEqual(['PER', 'PUBPER']);
    expect(result['needs-you (MCP) outcomes']).toEqual([]);
    // Graph: self member node + the public broadcast node; no tenant records.
    expect(result['workspace-graph nodes'].sort()).toEqual([
      'actor:member-owner',
      'project:PUB-SYS',
    ]);
  });

  it("'all' scope still never admits another person's records", () => {
    const result = admitted(ALL);
    // Every tenant + system record, but AP-PER/AP-OTH stay person-bound.
    for (const key of [
      'readConciergeHome approvals',
      'needs-you (shell) approvals',
      'needs-you (MCP) approvals',
    ] as const) {
      expect(result[key], key).not.toContain('PER');
      expect(result[key], key).not.toContain('OTH');
      expect(result[key], key).not.toContain('PUBPER');
      expect(result[key], key).toContain('ACME');
      expect(result[key], key).toContain('BETA');
      expect(result[key], key).toContain('SYS');
    }
  });
});
