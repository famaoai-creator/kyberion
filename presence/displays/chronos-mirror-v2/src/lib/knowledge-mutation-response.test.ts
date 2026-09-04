import { describe, expect, it } from 'vitest';
import {
  parseKnowledgeFeedbackResponse,
  parseKnowledgeMutationResponse,
} from './knowledge-mutation-response';

const candidate = {
  candidate_id: 'CAND-1',
  status: 'approved',
  proposed_memory_kind: 'heuristic',
  summary: 'Use the governed path',
  evidence_refs: [],
  sensitivity_tier: 'public',
  source_ref: 'mission:MSN-1',
  ratification_required: false,
};

describe('knowledge mutation response parsers', () => {
  it('accepts candidate and feedback success responses', () => {
    expect(parseKnowledgeMutationResponse({ ok: true, candidate })).toEqual({
      ok: true,
      candidate,
    });
    expect(
      parseKnowledgeFeedbackResponse({ ok: true, feedback_path: 'active/feedback.jsonl' })
    ).toEqual({
      ok: true,
      feedback_path: 'active/feedback.jsonl',
    });
  });

  it.each([
    ['mutation not ok', parseKnowledgeMutationResponse, { ok: false, candidate }],
    ['mutation missing candidate', parseKnowledgeMutationResponse, { ok: true }],
    ['feedback not ok', parseKnowledgeFeedbackResponse, { ok: false, feedback_path: 'x' }],
    ['feedback empty path', parseKnowledgeFeedbackResponse, { ok: true, feedback_path: '' }],
    [
      'dangerous candidate key',
      parseKnowledgeMutationResponse,
      { ok: true, candidate: { ...candidate, ['__proto__']: {} } },
    ],
  ])('rejects %s', (_label, parser, value) => {
    expect(parser(value)).toBeUndefined();
  });
});
