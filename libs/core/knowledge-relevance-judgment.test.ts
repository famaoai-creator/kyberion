import { afterEach, describe, expect, it } from 'vitest';
import {
  registerJudgmentBackend,
  resetJudgmentBackends,
  type JudgmentAnswer,
  type JudgmentBackend,
} from './judgment-backend.js';
import { registerOrganizationWorkJudgment } from './organization-operating-model-persistence.js';
import { selectRelevantKnowledge, type RelevanceCandidate } from './knowledge-relevance-judgment.js';

const CANDIDATES: RelevanceCandidate[] = [
  { id: 'a', title: 'Tier guard', excerpt: 'tier guard rules', fullLength: 1000 },
  { id: 'b', title: 'Voice actuator', excerpt: 'microphone handling', fullLength: 2000 },
  { id: 'c', title: 'Seam catalog', excerpt: 'provider seams', fullLength: 500 },
];

/** Answers false (irrelevant) for the listed ids, true for the rest. */
function provider(irrelevant: string[], confidence = 0.95): JudgmentBackend {
  return {
    judgment_id: 'laya-mlx',
    egress: 'local-only',
    supports: () => true,
    async judge(request) {
      return request.questions.map<JudgmentAnswer>((question) => {
        const id = question.id.replace('knowledge.relevant.', '');
        return {
          id: question.id,
          value: !irrelevant.includes(id),
          confidence,
          calibrated: false,
        };
      });
    },
  };
}

// `requireCalibrated` defaults to true here (measured: this provider is
// confidently wrong on 40% of the relevance answers it is sure about), so
// tests that exercise dropping opt out explicitly.
const base = {
  candidates: CANDIDATES,
  task: 'tier guard を直す',
  tier: 'personal' as const,
  requireCalibrated: false,
};

afterEach(() => {
  resetJudgmentBackends();
});

describe('selectRelevantKnowledge', () => {
  it('keeps everything by default, because nothing is calibrated for this question', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(['b']));
    const result = await selectRelevantKnowledge({ ...base, requireCalibrated: undefined });
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
  });

  it('keeps everything when no provider is registered', async () => {
    const result = await selectRelevantKnowledge(base);
    expect(result.kept).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
    expect(result.source).toBe('baseline');
    expect(result.charsSaved).toBe(0);
  });

  it('drops only what a provider is confidently sure is irrelevant', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(['b']));
    const result = await selectRelevantKnowledge(base);
    expect(result.kept.map((c) => c.id)).toEqual(['a', 'c']);
    expect(result.dropped.map((c) => c.id)).toEqual(['b']);
    expect(result.source).toBe('judgment');
    // Reported against the full document, not the excerpt shown to the model.
    expect(result.charsSaved).toBe(2000);
  });

  it('keeps a document the provider is only weakly sure about', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(['b'], 0.4));
    const result = await selectRelevantKnowledge(base);
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
  });

  it('never drops a pinned document', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend(provider(['a', 'b']));
    const result = await selectRelevantKnowledge({
      ...base,
      candidates: [{ ...CANDIDATES[0], pinned: true }, CANDIDATES[1], CANDIDATES[2]],
    });
    expect(result.kept.map((c) => c.id)).toContain('a');
    expect(result.dropped.map((c) => c.id)).toEqual(['b']);
  });

  it('keeps the whole pack rather than falling below minKeep', async () => {
    registerOrganizationWorkJudgment();
    // A provider that wants to drop everything is a provider to distrust.
    registerJudgmentBackend(provider(['a', 'b', 'c']));
    const result = await selectRelevantKnowledge({ ...base, minKeep: 2 });
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
    expect(result.reason).toMatch(/below minKeep/);
  });

  it('keeps everything when the provider throws', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider([]),
      async judge() {
        throw new Error('worker exploded');
      },
    });
    const result = await selectRelevantKnowledge(base);
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
  });

  it('keeps everything when the provider hangs', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({ ...provider([]), judge: () => new Promise(() => undefined) });
    const result = await selectRelevantKnowledge({ ...base, timeoutMs: 50 });
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
  });

  it('keeps everything when a candidate has no answer', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider([]),
      async judge() {
        return [];
      },
    });
    const result = await selectRelevantKnowledge(base);
    expect(result.kept).toHaveLength(3);
  });

  it('never sends a personal-tier pack to an external provider', async () => {
    registerOrganizationWorkJudgment();
    registerJudgmentBackend({
      ...provider(['b']),
      judgment_id: 'typesafe-jev',
      egress: 'external-api',
    });
    const result = await selectRelevantKnowledge(base);
    expect(result.kept).toHaveLength(3);
    expect(result.source).toBe('baseline');
  });

  it('batches candidates across calls', async () => {
    registerOrganizationWorkJudgment();
    let calls = 0;
    registerJudgmentBackend({
      ...provider(['b']),
      async judge(request) {
        calls += 1;
        return request.questions.map((question) => ({
          id: question.id,
          value: !question.id.endsWith('.b'),
          confidence: 0.95,
          calibrated: false,
        }));
      },
    });
    await selectRelevantKnowledge({ ...base, chunkSize: 2 });
    expect(calls).toBe(2);
  });
});
