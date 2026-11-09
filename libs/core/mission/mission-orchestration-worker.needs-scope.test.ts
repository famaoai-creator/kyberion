import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRelevantPromotedKnowledge: vi.fn(),
  queryTenantKnowledge: vi.fn(),
  recordKnowledgeDelivery: vi.fn(),
}));

vi.mock('../knowledge/promoted-knowledge-retrieval.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/promoted-knowledge-retrieval.js')>()),
  findRelevantPromotedKnowledge: mocks.findRelevantPromotedKnowledge,
}));
vi.mock('../organization/tenant-knowledge-retrieval.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../organization/tenant-knowledge-retrieval.js')>()),
  queryTenantKnowledge: mocks.queryTenantKnowledge,
}));
vi.mock('../knowledge/knowledge-feedback-loop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/knowledge-feedback-loop.js')>()),
  recordKnowledgeDelivery: mocks.recordKnowledgeDelivery,
}));

import { buildNeedsKnowledgeReinforcementLines } from './mission-orchestration-worker-part-context.js';

const entry = (path: string) => ({
  path,
  title: path,
  excerpt: 'excerpt',
  source_sha256: 'a'.repeat(64),
  tags: [],
  score: 0.5,
});

afterEach(() => {
  mocks.findRelevantPromotedKnowledge.mockReset();
  mocks.queryTenantKnowledge.mockReset();
  mocks.recordKnowledgeDelivery.mockReset();
});

describe('needs-driven retry retrieval uses the first-round scope', () => {
  it('searches the confidential tenant lane and honors governed slice excludes', async () => {
    mocks.findRelevantPromotedKnowledge.mockResolvedValue([
      entry('knowledge/product/evolution/distill_unreviewed.md'),
    ]);
    mocks.queryTenantKnowledge.mockResolvedValue([
      entry('knowledge/confidential/tenant-a/evolution/distill_rollback.md'),
    ]);

    mocks.recordKnowledgeDelivery.mockImplementation((input) => ({
      refs: input.refs.map((ref: object) => ({
        ...ref,
        delivery_id: 'retry-receipt',
        scope_context: input.scope,
      })),
    }));
    const deliveredRefs: import('../knowledge/knowledge-feedback-loop.js').DeliveredKnowledgeRef[] =
      [];
    const lines = await buildNeedsKnowledgeReinforcementLines({
      missionId: 'MSN-NEEDS',
      taskId: 'T1',
      needs: ['rollback procedure'],
      deliveredKnowledgeRefs: deliveredRefs,
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

    const tenantScope = {
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-NEEDS',
    };
    expect(mocks.findRelevantPromotedKnowledge.mock.calls[0][0].scope).toEqual(tenantScope);
    expect(mocks.queryTenantKnowledge.mock.calls[0][0]).toMatchObject({
      tenantSlug: 'tenant-a',
      scope: tenantScope,
    });
    const text = lines.join('\n');
    expect(text).toContain('knowledge/confidential/tenant-a/evolution/distill_rollback.md');
    expect(text).not.toContain('knowledge/product/evolution/distill_unreviewed.md');
    expect(deliveredRefs).toHaveLength(1);
    expect(deliveredRefs[0].scope_context).toEqual({
      tier: 'confidential',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      project_id: 'PRJ-A',
      mission_id: 'MSN-NEEDS',
      task_id: 'T1',
    });
    expect(deliveredRefs[0].snapshot).toMatchObject({
      form: 'needs_retry',
      source_sha256: 'a'.repeat(64),
    });
    expect(text).toContain(deliveredRefs[0].snapshot!.text);
  });

  it('a public mission searches without a tenant scope', async () => {
    mocks.findRelevantPromotedKnowledge.mockResolvedValue([]);
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
    expect(mocks.findRelevantPromotedKnowledge.mock.calls[0][0].scope).toEqual({
      tier: 'public',
      mission_id: 'MSN-NEEDS-PUBLIC',
    });
    expect(mocks.queryTenantKnowledge).not.toHaveBeenCalled();
  });
});
