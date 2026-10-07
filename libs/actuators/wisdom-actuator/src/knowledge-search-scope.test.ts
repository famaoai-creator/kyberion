import { afterEach, describe, expect, it, vi } from 'vitest';

const index = vi.hoisted(() => ({
  buildScopedIndex: vi.fn(async () => ({ hints: [] })),
  queryKnowledgeHybrid: vi.fn(async () => []),
}));
vi.mock('@agent/core/knowledge-index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge-index')>()),
  buildScopedIndex: index.buildScopedIndex,
  queryKnowledgeHybrid: index.queryKnowledgeHybrid,
}));

import { handleAction } from './index.js';

afterEach(() => {
  index.buildScopedIndex.mockClear();
  index.queryKnowledgeHybrid.mockClear();
});

describe('knowledge_search containment scope', () => {
  it('scans with the participant organization/project/mission chain', async () => {
    await handleAction({
      action: 'knowledge_search',
      params: { query: 'rollback runbook', tier: 'confidential' },
      context: {
        tenant_slug: 'tenant-a',
        security_scope: {
          tenant_slug: 'tenant-a',
          tenant_id: 'tenant-a',
          organization_id: 'org-a',
          project_id: 'PRJ-A',
          mission_id: 'MSN-A',
          read_tiers: ['public', 'confidential'],
          write_tier: 'confidential',
          purpose: 'mission-execution',
        },
      },
    } as never);

    expect(index.buildScopedIndex).toHaveBeenCalledTimes(1);
    expect(index.buildScopedIndex.mock.calls[0][0]).toMatchObject({
      tiers: ['public', 'confidential'],
      customerId: 'tenant-a',
      scopeContext: {
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        project_id: 'PRJ-A',
        mission_id: 'MSN-A',
      },
    });
  });
});
