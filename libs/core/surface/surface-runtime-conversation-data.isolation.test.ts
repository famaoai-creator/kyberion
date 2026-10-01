// Team Channel E: an isolated (team) turn answers knowledge questions from
// public knowledge plus its own tenant only, and never discloses the owner's
// calendar or presence.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryTenantKnowledge: vi.fn(),
  queryKnowledgeHybrid: vi.fn(),
  readScheduleAgenda: vi.fn(async () => 'owner agenda'),
}));

vi.mock('../organization/tenant-knowledge-retrieval.js', () => ({
  queryTenantKnowledge: mocks.queryTenantKnowledge,
}));
vi.mock('../knowledge/knowledge-index.js', async () => ({
  ...(await vi.importActual<typeof import('../knowledge/knowledge-index.js')>(
    '../knowledge/knowledge-index.js'
  )),
  queryKnowledgeHybrid: mocks.queryKnowledgeHybrid,
}));
vi.mock('./surface-runtime-helpers.js', async () => ({
  ...(await vi.importActual<typeof import('./surface-runtime-helpers.js')>(
    './surface-runtime-helpers.js'
  )),
  loadKnowledgeHintIndex: async () => ({}),
  readScheduleAgenda: mocks.readScheduleAgenda,
}));

import { handleSurfaceQueryRoute } from './surface-runtime-conversation-data.js';
import type { SurfaceRuntimeRouteContext } from './surface-runtime-router.js';

function routeContext(
  isolation?: SurfaceRuntimeRouteContext['input']['isolation']
): SurfaceRuntimeRouteContext {
  return {
    input: {
      agentId: 'slack-surface-agent',
      query: 'deployment checklist',
      senderAgentId: 'test',
      surface: 'slack',
      ...(isolation ? { isolation } : {}),
    },
    compiledFlow: null,
    structuredQuery: 'deployment checklist',
    parsedSlackPrompt: null,
  };
}

describe('handleSurfaceQueryRoute tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryKnowledgeHybrid.mockResolvedValue([
      { topic: 'Public guide', hint: 'public hint', source: 'knowledge/public/guide.md' },
    ]);
    mocks.queryTenantKnowledge.mockResolvedValue([
      {
        path: 'knowledge/confidential/acme/runbook.md',
        title: 'Acme runbook',
        excerpt: 'acme hint',
        tags: [],
        score: 0.9,
        tenant_slug: 'acme',
      },
    ]);
  });

  it('adds the channel tenant knowledge for a confidential team channel', async () => {
    const result = await handleSurfaceQueryRoute(
      routeContext({ tenantSlug: 'acme', maxTier: 'confidential' }),
      { queryText: 'deployment checklist', queryType: 'knowledge_search' } as never
    );
    expect(mocks.queryTenantKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantSlug: 'acme',
        scope: { tier: 'confidential', tenant_slug: 'acme' },
      })
    );
    expect(result.text).toContain('Acme runbook');
    expect(result.text).toContain('Public guide');
  });

  it('keeps a public team channel on public knowledge', async () => {
    const result = await handleSurfaceQueryRoute(
      routeContext({ tenantSlug: 'acme', maxTier: 'public' }),
      { queryText: 'deployment checklist', queryType: 'knowledge_search' } as never
    );
    expect(mocks.queryTenantKnowledge).not.toHaveBeenCalled();
    expect(result.text).not.toContain('Acme runbook');
  });

  it('never reads tenant knowledge for an owner turn', async () => {
    await handleSurfaceQueryRoute(routeContext(), {
      queryText: 'deployment checklist',
      queryType: 'knowledge_search',
    } as never);
    expect(mocks.queryTenantKnowledge).not.toHaveBeenCalled();
  });

  it('refuses the owner agenda and location in a shared channel', async () => {
    const isolation = { tenantSlug: 'acme', maxTier: 'confidential' as const };
    const agenda = await handleSurfaceQueryRoute(routeContext(isolation), {
      queryText: 'today',
      intentId: 'schedule-read-agenda',
    } as never);
    const location = await handleSurfaceQueryRoute(routeContext(isolation), {
      queryText: 'where',
      queryType: 'location',
    } as never);
    expect(mocks.readScheduleAgenda).not.toHaveBeenCalled();
    expect(agenda.text).toContain('not available in a shared channel');
    expect(location.text).toContain('not available in a shared channel');
  });
});
