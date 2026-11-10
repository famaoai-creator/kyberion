import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFacadeProposalRow } from '@agent/core/knowledge/facade-proposal-rows';

/** D8: /api/distill-candidates lists queue-row proposals for the resolved viewer, legacy as history. */
const store = vi.hoisted(() => ({
  rows: [] as unknown[],
  legacy: [] as unknown[],
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listMemoryPromotionCandidates: () => store.rows,
}));
vi.mock('@agent/core/knowledge/distill-candidate-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listDistillCandidateRecords: () => store.legacy,
}));
import { listReuseItemsForViewer } from './presence-studio-runtime-data.js';

function row(id: string, scope: Record<string, unknown>, decidedVia = 'concierge') {
  return buildFacadeProposalRow(
    {
      recordKind: decidedVia === 'concierge' ? 'mission_seed' : 'execution_feedback',
      learningKind: 'lesson',
      decidedVia,
      idPrefix: 'DSC',
    },
    {
      candidate_id: id,
      source_type: 'mission',
      title: `title ${id}`,
      summary: `summary ${id}`,
      target_kind: 'sop_candidate',
      evidence_refs: [`mission:${id}`],
      metadata: { private_detail: 'never leaves the server' },
      proposedMemoryKind: 'sop',
      scope: scope as never,
      promoted_ref: `knowledge/confidential/acme/${id}.md`,
      project_id: 'proj-a',
    }
  );
}

beforeEach(() => {
  store.rows = [
    row('DSC-ACME', { tier: 'confidential', tenant_slug: 'acme' }),
    row('DSC-GLOBEX', { tier: 'confidential', tenant_slug: 'globex' }),
    row('DSC-OWNER', { tier: 'personal', owner_nhi: 'user:viewer' }),
    row('DSC-PUBLIC', { tier: 'public' }, 'pnpm kyberion improvements'),
  ];
  store.legacy = [
    {
      candidate_id: 'DSC-OLD-PUBLIC',
      source_type: 'mission',
      tier: 'public',
      title: 'old public',
      summary: 's',
      status: 'promoted',
      target_kind: 'pattern',
      promoted_ref: 'knowledge/public/old.md',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      candidate_id: 'DSC-OLD-CONFIDENTIAL',
      source_type: 'mission',
      tier: 'confidential',
      title: 'old confidential',
      summary: 's',
      status: 'proposed',
      target_kind: 'pattern',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];
});

describe('presence studio reuse items (D8)', () => {
  it('shows a tenant viewer only its tenant and public proposals, plus public history', () => {
    const items = listReuseItemsForViewer({ principalId: 'user:viewer', tenantSlugs: ['acme'] });
    expect(items.map((item) => [item.candidate_id, item.review])).toEqual([
      ['DSC-ACME', 'here'],
      ['DSC-PUBLIC', 'elsewhere'],
      ['DSC-OLD-PUBLIC', 'history'],
    ]);
    expect(items[0]).toMatchObject({
      title: 'title DSC-ACME',
      promoted_ref: 'knowledge/confidential/acme/DSC-ACME.md',
      project_id: 'proj-a',
    });
    expect(JSON.stringify(items)).not.toContain('private_detail');
  });

  it('never lists personal rows, even for an all-tenant viewer', () => {
    const ids = listReuseItemsForViewer({ tenantSlugs: 'all' }).map((item) => item.candidate_id);
    expect(ids).toEqual(expect.arrayContaining(['DSC-ACME', 'DSC-GLOBEX', 'DSC-OLD-CONFIDENTIAL']));
    expect(ids).not.toContain('DSC-OWNER');
  });
});
