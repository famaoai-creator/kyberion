import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRelevantDistilledKnowledge: vi.fn(),
  recordKnowledgeDelivery: vi.fn(),
}));

vi.mock('../knowledge/distill-knowledge-injector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/distill-knowledge-injector.js')>()),
  findRelevantDistilledKnowledge: mocks.findRelevantDistilledKnowledge,
}));
vi.mock('../knowledge/knowledge-feedback-loop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/knowledge-feedback-loop.js')>()),
  recordKnowledgeDelivery: mocks.recordKnowledgeDelivery,
}));

import { buildNeedsKnowledgeReinforcementLines } from './mission-orchestration-worker-part-context.js';

const entry = (path: string) => ({ path, title: path, excerpt: 'excerpt', tags: [], score: 0.5 });

afterEach(() => {
  mocks.findRelevantDistilledKnowledge.mockReset();
  mocks.recordKnowledgeDelivery.mockReset();
});

describe('needs-driven retry retrieval uses the first-round scope', () => {
  it('searches the confidential tenant lane and honors governed slice excludes', async () => {
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([
      entry('knowledge/product/evolution/distill_unreviewed.md'),
      entry('knowledge/confidential/tenant-a/evolution/distill_rollback.md'),
    ]);

    const lines = await buildNeedsKnowledgeReinforcementLines({
      missionId: 'MSN-NEEDS',
      taskId: 'T1',
      needs: ['rollback procedure'],
      deliveredKnowledgeRefs: [],
      securityScope: {
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        project_id: 'PRJ-A',
        mission_id: 'MSN-NEEDS',
        read_tiers: ['public', 'confidential'],
        write_tier: 'confidential',
        purpose: 'mission-execution',
      },
    });

    expect(mocks.findRelevantDistilledKnowledge.mock.calls[0][0].scope).toEqual({
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-NEEDS',
    });
    const text = lines.join('\n');
    expect(text).toContain('knowledge/confidential/tenant-a/evolution/distill_rollback.md');
    expect(text).not.toContain('knowledge/product/evolution/distill_unreviewed.md');
  });

  it('a public mission searches without a tenant scope', async () => {
    mocks.findRelevantDistilledKnowledge.mockResolvedValue([]);
    await buildNeedsKnowledgeReinforcementLines({
      missionId: 'MSN-NEEDS-PUBLIC',
      taskId: 'T1',
      needs: ['rollback procedure'],
      deliveredKnowledgeRefs: [],
      securityScope: {
        tenant_slug: 'tenant-a',
        mission_id: 'MSN-NEEDS-PUBLIC',
        read_tiers: ['public'],
        write_tier: 'public',
        purpose: 'mission-execution',
      },
    });
    expect(mocks.findRelevantDistilledKnowledge.mock.calls[0][0]).not.toHaveProperty('scope');
  });
});
