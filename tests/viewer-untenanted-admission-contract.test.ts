import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Untenanted admission contract (one rule: `admitsTenant`).
 *
 * The shell's system selection is the server-resolved scope
 * `{ tenantSlugs: [], includeUntenanted: true }`; a company selection is
 * `{ tenantSlugs: [slug] }`. Every reader that takes a viewer scope must
 * admit the same records for both:
 *
 *   - `readConciergeHome`     (approval queue)
 *   - `collectHomeDashboard`  (missions, deliverables)
 *   - needs-you               (the shell reader and the MCP default reader)
 *
 * The system selection sees the company-less records and no company's; a
 * company sees its own and neither the company-less nor another company's.
 * The stores are stubbed with one shared fixture; the readers and their
 * admission rules are real.
 */

const fixture = vi.hoisted(() => {
  const at = '2026-11-05T10:00:00.000Z';
  const approval = (id: string, tenant?: string) => ({
    id,
    kind: 'mission_gate',
    channel: 'external-operation',
    storageChannel: 'external-operation',
    title: `Approval required: ${id}`,
    summary: '',
    status: 'pending',
    requestedBy: 'agent:planner',
    requestedAt: at,
    scope: { tier: 'confidential', ...(tenant ? { tenant_slug: tenant } : {}) },
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
    approvals: [approval('AP-ACME', 'acme'), approval('AP-BETA', 'beta'), approval('AP-SYS')],
    inbox: [inbox('IN-ACME', 'acme'), inbox('IN-BETA', 'beta'), inbox('IN-SYS')],
    missions: [mission('MSN-ACME', 'acme'), mission('MSN-BETA', 'beta'), mission('MSN-SYS')],
    artifacts: [artifact('ART-ACME', 'acme'), artifact('ART-BETA', 'beta'), artifact('ART-SYS')],
  };
});

vi.mock('@agent/core/governance/approval-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/governance/approval-store')>()),
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
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId: 'human:contract',
    ...scope,
  } as ConciergeViewerContext;
}

const SYSTEM = viewer({ tenantSlugs: [], includeUntenanted: true });
const ACME = viewer({ tenantSlugs: ['acme'] });

const suffixes = (ids: string[]) =>
  [...new Set(ids.map((id) => id.replace(/^.*-(ACME|BETA|SYS)$/, '$1')))].sort();

function admitted(view: ConciergeViewerContext) {
  const home = readConciergeHome(view, { limit: 50 });
  const dashboard = collectHomeDashboard(view as never, Date.parse('2026-11-05T12:00:00Z'));
  const shell = readConciergeNeedsYou(view);
  const mcp = readNeedsYouSources(toSurfaceAuthorizationContext(view));
  return {
    'readConciergeHome approvals': suffixes(home.approval_queue.map((item) => item.id)),
    'collectHomeDashboard missions': suffixes(dashboard.missions.blocked.map((m) => m.id)),
    'collectHomeDashboard deliverables': suffixes(dashboard.deliverables.map((d) => d.id)),
    'needs-you (shell) approvals': suffixes(shell.approvals.map((item) => item.id)),
    'needs-you (MCP) approvals': suffixes(mcp.approvals.map((item) => item.id)),
    'needs-you (MCP) outcomes': suffixes(mcp.outcomes.map((item) => item.entry_id)),
  };
}

describe('untenanted admission is one rule across viewer-scoped readers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the system selection sees only the company-less records, in every reader', () => {
    const result = admitted(SYSTEM);
    for (const [reader, seen] of Object.entries(result)) {
      expect(seen, `${reader} — system selection`).toEqual(['SYS']);
    }
  });

  it('a single company sees only its own records, never the company-less or another company', () => {
    const result = admitted(ACME);
    for (const [reader, seen] of Object.entries(result)) {
      expect(seen, `${reader} — single company`).toEqual(['ACME']);
    }
  });
});
