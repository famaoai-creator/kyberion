import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ ready: false }));
vi.mock('../reasoning/judgment-provider-bootstrap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reasoning/judgment-provider-bootstrap.js')>()),
  judgmentAssistReady: () => gate.ready,
}));
const relevance = vi.hoisted(() => ({ selectRelevantKnowledge: vi.fn() }));
vi.mock('../knowledge/knowledge-relevance-judgment.js', () => relevance);
vi.mock('../knowledge/distill-knowledge-injector.js', () => ({
  findRelevantDistilledKnowledge: vi.fn(async () => []),
}));

import { findRelevantDistilledKnowledge } from '../knowledge/distill-knowledge-injector.js';
import { loadKnowledgeHintsIfPossible } from './mission-context-pack-knowledge.js';
import type { MissionStateSummary } from './mission-context-pack-types.js';

const distill = Array.from({ length: 6 }, (_, i) => ({
  path: `knowledge/product/doc-${i}.md`,
  title: `Doc ${i}`,
  excerpt: `excerpt ${i}`,
  tags: [],
  score: 0.9 - i * 0.1,
}));

const missionState = {
  mission_id: 'MSN-JUDGMENT-CAP',
  mission_type: 'product_development',
  tier: 'public',
  status: 'active',
} as unknown as MissionStateSummary;

async function load() {
  return loadKnowledgeHintsIfPossible({
    missionState,
    workItem: { title: 'Repair the login flow', description: 'session refresh' } as never,
    knowledgeSlicesPath: '/nonexistent/knowledge-slices.json',
  });
}

beforeEach(() => {
  vi.mocked(findRelevantDistilledKnowledge).mockImplementation(async (input) =>
    distill.slice(0, input.limit)
  );
});

afterEach(() => {
  gate.ready = false;
  relevance.selectRelevantKnowledge.mockReset();
  vi.mocked(findRelevantDistilledKnowledge).mockReset();
});

describe('relevance narrowing keeps the hint budget', () => {
  it('without a calibrated judgment, fetches and delivers exactly the budget', async () => {
    const hints = await load();
    expect(vi.mocked(findRelevantDistilledKnowledge).mock.calls[0][0].limit).toBe(3);
    expect(hints.map((h) => h.path)).toEqual(distill.slice(0, 3).map((d) => d.path));
    expect(relevance.selectRelevantKnowledge).not.toHaveBeenCalled();
  });

  it('with a calibrated judgment, judges a wider pool and backfills dropped hints', async () => {
    gate.ready = true;
    relevance.selectRelevantKnowledge.mockImplementation(async ({ candidates }) => ({
      source: 'judgment',
      kept: candidates.filter((c: { id: string }) => c.id !== distill[0].path),
      dropped: candidates.filter((c: { id: string }) => c.id === distill[0].path),
    }));

    const hints = await load();
    expect(vi.mocked(findRelevantDistilledKnowledge).mock.calls[0][0].limit).toBe(6);
    expect(relevance.selectRelevantKnowledge.mock.calls[0][0].candidates).toHaveLength(6);
    expect(hints.map((h) => h.path)).toEqual(distill.slice(1, 4).map((d) => d.path));
  });

  it('a judgment that falls back still caps the wider pool at the budget', async () => {
    gate.ready = true;
    relevance.selectRelevantKnowledge.mockResolvedValue({ source: 'fallback', kept: [] });

    const hints = await load();
    expect(hints.map((h) => h.path)).toEqual(distill.slice(0, 3).map((d) => d.path));
  });
});

describe('retrieval scope and source snapshot precede provider judgment', () => {
  it('keeps organization/project siblings out of every relevance payload', async () => {
    gate.ready = true;
    const own = {
      ...distill[0],
      path: 'knowledge/confidential/tenant-a/organizations/org-a/projects/PRJ-A/own.md',
    };
    const sibling = {
      ...distill[1],
      path: 'knowledge/confidential/tenant-a/organizations/org-b/projects/PRJ-B/secret.md',
      excerpt: 'DO NOT EGRESS',
    };
    vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue([own, sibling, distill[2]]);
    relevance.selectRelevantKnowledge.mockImplementation(async ({ candidates }) => ({
      source: 'judgment',
      kept: candidates,
      dropped: [],
    }));
    const hints = await loadKnowledgeHintsIfPossible({
      missionState: {
        ...missionState,
        tier: 'confidential',
        tenant_slug: 'tenant-a',
        organization_id: 'org-a',
        relationships: { project: { project_id: 'PRJ-A' } },
      },
      knowledgeSlicesPath: '/nonexistent/knowledge-slices.json',
    });
    expect(hints.map((hint) => hint.path)).not.toContain(sibling.path);
    expect(JSON.stringify(relevance.selectRelevantKnowledge.mock.calls)).not.toContain(
      'DO NOT EGRESS'
    );
    expect(vi.mocked(findRelevantDistilledKnowledge).mock.calls[0][0].scope).toMatchObject({
      organization_id: 'org-a',
      project_id: 'PRJ-A',
    });
  });

  it('retains the source hash paired with the extracted hint across awaited judgment', async () => {
    gate.ready = true;
    const source = { ...distill[0], source_sha256: 'a'.repeat(64) };
    vi.mocked(findRelevantDistilledKnowledge).mockResolvedValue([source, distill[1]]);
    relevance.selectRelevantKnowledge.mockImplementation(async ({ candidates }) => {
      source.source_sha256 = 'b'.repeat(64);
      source.excerpt = 'later source version';
      return { source: 'judgment', kept: candidates, dropped: [] };
    });
    const hints = await load();
    expect(hints[0]).toMatchObject({ source_sha256: 'a'.repeat(64), excerpt: distill[0].excerpt });
  });
});
