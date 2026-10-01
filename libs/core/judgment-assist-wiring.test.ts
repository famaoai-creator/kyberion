import { afterEach, describe, expect, it, vi } from 'vitest';

// Simulates a calibration fit landing: the gate opens, so the wired call
// sites must now take the judgment (the direction the inert tests cannot show).
vi.mock('./reasoning/judgment-provider-bootstrap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reasoning/judgment-provider-bootstrap.js')>()),
  judgmentAssistReady: () => true,
}));
const relevance = vi.hoisted(() => ({ selectRelevantKnowledge: vi.fn() }));
vi.mock('./knowledge/knowledge-relevance-judgment.js', () => relevance);

import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentBackend,
} from './reasoning/judgment-backend.js';
import { classifyError } from './error-classifier.js';
import { ERROR_CATEGORY_QUESTION, refineErrorClassification } from './error-classifier-judgment.js';
import { narrowKnowledgeHintsWithJudgment } from './mission/mission-context-pack-knowledge.js';

const UNMATCHED = '[OP_KIND_MISMATCH] knowledge_search is registered as capture';

const provider: JudgmentBackend = {
  judgment_id: 'laya-mlx',
  egress: 'local-only',
  supports: (question) => question.id === ERROR_CATEGORY_QUESTION,
  async judge(request) {
    return request.questions.map((question) => ({
      id: question.id,
      value: 'invalid_input',
      confidence: 0.95,
      calibrated: false,
    }));
  },
};

afterEach(() => {
  resetJudgmentBackends();
  relevance.selectRelevantKnowledge.mockReset();
});

describe('judgment assists once calibrated', () => {
  it('lets the pipeline recovery path take a judged category', async () => {
    registerJudgmentBackend(provider);
    expect(classifyError(UNMATCHED).category).toBe('unknown');
    // requireCalibrated:false stands in for the fit the file would carry.
    const refined = await refineErrorClassification(UNMATCHED, { requireCalibrated: false });
    expect(refined.category).toBe('invalid_input');
    expect(refined.ruleId).toBe('judgment');
    expect(refined).not.toHaveProperty('source');
  });

  it('narrows context-pack hints to what the judgment kept, never pinned ones', async () => {
    const hints = [
      { path: 'knowledge/a.md', title: 'A', excerpt: 'a', tags: [] },
      { path: 'knowledge/b.md', title: 'B', excerpt: 'b', tags: [] },
    ];
    relevance.selectRelevantKnowledge.mockResolvedValue({
      kept: [{ id: 'knowledge/a.md', excerpt: 'a' }],
      dropped: [{ id: 'knowledge/b.md', excerpt: 'b' }],
      source: 'judgment',
      reason: 'b irrelevant',
      charsSaved: 1,
    });
    const narrowed = await narrowKnowledgeHintsWithJudgment(hints, {
      task: 'fix login',
      tier: 'public',
      pinnedPaths: new Set(['knowledge/a.md']),
    });
    expect(narrowed.map((hint) => hint.path)).toEqual(['knowledge/a.md']);
    expect(relevance.selectRelevantKnowledge.mock.calls[0]?.[0].candidates[0].pinned).toBe(true);

    relevance.selectRelevantKnowledge.mockResolvedValue({
      kept: hints.map((hint) => ({ id: hint.path, excerpt: hint.excerpt })),
      dropped: [],
      source: 'baseline',
      reason: 'nothing confidently irrelevant',
      charsSaved: 0,
    });
    expect(await narrowKnowledgeHintsWithJudgment(hints, { task: 'x', tier: 'public' })).toBe(
      hints
    );
  });
});
