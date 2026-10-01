import { afterEach, describe, expect, it } from 'vitest';
import { registerJudgmentBackend, resetJudgmentBackends } from '../reasoning/judgment-backend.js';
import { narrowKnowledgeHintsWithJudgment } from './mission-context-pack-knowledge.js';

afterEach(() => {
  resetJudgmentBackends();
});

describe('narrowKnowledgeHintsWithJudgment', () => {
  it('keeps the pack itself and asks no provider while nothing is calibrated', async () => {
    let asked = 0;
    registerJudgmentBackend({
      judgment_id: 'laya-mlx',
      egress: 'local-only',
      supports: () => true,
      async judge(request) {
        asked += 1;
        return request.questions.map((question) => ({
          id: question.id,
          value: false,
          confidence: 0.99,
          calibrated: false,
        }));
      },
    });
    const hints = [
      { path: 'knowledge/a.md', title: 'A', excerpt: 'alpha', tags: [] },
      { path: 'knowledge/b.md', title: 'B', excerpt: 'beta', tags: [] },
    ];
    const narrowed = await narrowKnowledgeHintsWithJudgment(hints, {
      task: 'repair the login flow',
      tier: 'public',
    });
    expect(narrowed).toBe(hints);
    expect(asked).toBe(0);
  });
});
