import { describe, expect, it } from 'vitest';
import { parseKnowledgeFeedbackInput } from './knowledge-feedback-input';

describe('parseKnowledgeFeedbackInput', () => {
  it('accepts a scoped knowledge feedback payload', () => {
    expect(
      parseKnowledgeFeedbackInput({
        document_path: 'knowledge/confidential/acme/guide.md',
        verdict: 'useful',
        tenant: 'acme',
      })
    ).toEqual({
      documentPath: 'knowledge/confidential/acme/guide.md',
      verdict: 'useful',
      tenant: 'acme',
    });
  });

  it('rejects traversal, wrong types, and unknown fields', () => {
    expect(() =>
      parseKnowledgeFeedbackInput({
        document_path: 'knowledge/public/../secret.json',
        verdict: 'useful',
      })
    ).toThrow('document_path');
    expect(() =>
      parseKnowledgeFeedbackInput({
        document_path: 'knowledge/public/guide.md',
        verdict: ['useful'],
      })
    ).toThrow('verdict');
    expect(() =>
      parseKnowledgeFeedbackInput({
        document_path: 'knowledge/public/guide.md',
        verdict: 'useful',
        reason: {},
      })
    ).toThrow('reason');
    expect(() =>
      parseKnowledgeFeedbackInput({
        document_path: 'knowledge/public/guide.md',
        verdict: 'useful',
        extra: true,
      })
    ).toThrow('unexpected knowledge feedback field');
  });
});
