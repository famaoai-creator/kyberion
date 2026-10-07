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
