import { describe, expect, it } from 'vitest';
import {
  conceptIdForSession,
  hearingAnswersToProductConcept,
  productConceptGaps,
} from './product-concept.js';

const NOW = '2026-09-14T00:00:00.000Z';
const recordedBy = { kind: 'human' as const, id: 'user:alice' };

describe('product concept from a web_app_build hearing', () => {
  it('maps answered requirements and omits the unanswered ones without inventing', () => {
    const concept = hearingAnswersToProductConcept(
      [
        { id: 'audience', answer: 'field sales staff', source_turn: 't1' },
        { id: 'problem', answer: 'deal status is scattered across chats' },
        { id: 'core_flow', answer: 'log a deal → update stage → weekly review' },
        { id: 'success', answer: 'every open deal has a stage updated within 7 days' },
        { id: 'constraints', answer: 'no customer PII; runs on the intranet' },
        { id: 'visual_direction' },
      ],
      { sessionId: 'Sess_01', scenario: 'web_app_build', recordedBy, now: NOW }
    );
    expect(concept.id).toBe('PC-sess-01');
    expect(concept.status).toBe('draft');
    expect(concept.title).toBe('deal status is scattered across chats');
    expect(concept.for_whom).toEqual([
      {
        actor: 'field sales staff',
        context: 'log a deal → update stage → weekly review',
        primary: true,
      },
    ]);
    expect(concept.promises).toEqual([
      {
        statement: 'every open deal has a stage updated within 7 days',
        measured_by: 'every open deal has a stage updated within 7 days',
        status: 'proposed',
      },
    ]);
    expect(concept.constraints).toEqual(['no customer PII', 'runs on the intranet']);
    expect(concept.visual_direction).toBeUndefined();
    expect(concept.source).toEqual({
      kind: 'hearing',
      session_id: 'Sess_01',
      scenario: 'web_app_build',
    });
    expect(productConceptGaps(concept)).toEqual([]);
  });

  it('names what is still missing for an empty hearing', () => {
    const concept = hearingAnswersToProductConcept([], {
      sessionId: 'empty',
      scenario: 'web_app_build',
      recordedBy,
      now: NOW,
    });
    expect(productConceptGaps(concept)).toEqual(['for_whom', 'promises', 'problem']);
    expect(concept.title).toBe('empty');
  });

  it('derives a safe concept id from any session id', () => {
    expect(conceptIdForSession('ABC def/ghi')).toBe('PC-abc-def-ghi');
    expect(conceptIdForSession('///')).toBe('PC-hearing');
  });
});
