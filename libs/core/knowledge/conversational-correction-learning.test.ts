import { describe, expect, it, vi } from 'vitest';
import {
  captureConversationalCorrectionLearning,
  detectConversationalCorrection,
} from './conversational-correction-learning.js';

describe('conversational-correction-learning (IL-05)', () => {
  it('detects Japanese and English standing preferences with high confidence', () => {
    const ja = detectConversationalCorrection('次からは箇条書きで簡潔にまとめて');
    expect(ja).toMatchObject({
      matched: true,
      category: 'style_format',
      confidence: 'high',
    });

    const en = detectConversationalCorrection(
      'Next time ask first before modifying production config'
    );
    expect(en).toMatchObject({
      matched: true,
      category: 'scope_boundary',
      confidence: 'high',
    });

    const priority = detectConversationalCorrection('今後は朝一で優先度高いものから並べて');
    expect(priority).toMatchObject({
      matched: true,
      category: 'priority_timing',
      confidence: 'high',
    });
  });

  it('ignores short or non-correction utterances to avoid false positives', () => {
    expect(detectConversationalCorrection('ok').matched).toBe(false);
    expect(detectConversationalCorrection('違う、').matched).toBe(false);
    expect(detectConversationalCorrection('Please show today tasks').matched).toBe(false);
  });

  it('fails closed when no usable scope is provided', () => {
    const res = captureConversationalCorrectionLearning({
      text: 'Next time keep it concise with bullet points',
    });
    expect(res).toMatchObject({
      captured: false,
      reason: 'scope_required',
      detection: { matched: true, category: 'style_format' },
    });

    const missingTenant = captureConversationalCorrectionLearning({
      text: '次からは確認してから進めて',
      scope: { tier: 'confidential' },
    });
    expect(missingTenant.captured).toBe(false);
    expect(missingTenant.reason).toBe('scope_required');
  });

  it('records scoped feedback and materializes a reviewable candidate when scope is valid', () => {
    const recordFeedback = vi.fn((input) => ({
      kind: 'execution-feedback' as const,
      schema_version: '1.0.0' as const,
      feedback_id: 'FB-1',
      scenario_id: input.scenario_id,
      intent_id: input.intent_id,
      outcome: input.outcome,
      correction: input.correction,
      source: 'user' as const,
      recorded_at: '2026-11-25T00:00:00.000Z',
      scope: input.scope,
    }));
    const materializeCandidate = vi.fn(() => ({
      summary: {} as never,
      candidate: { candidate_id: 'CAND-1', status: 'proposed' } as never,
    }));

    const res = captureConversationalCorrectionLearning({
      text: '今後は箇条書きで簡潔に出して',
      scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' },
      correlationId: 'corr-1',
      surface: 'slack',
      recordFeedback: recordFeedback as never,
      materializeCandidate: materializeCandidate as never,
    });

    expect(res.captured).toBe(true);
    expect(res.reason).toBe('captured');
    expect(recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'partially_satisfied',
        scope: { tier: 'confidential', tenant_slug: 'acme', organization_id: 'org-1' },
      })
    );
    expect(materializeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedLearningEvidence: ['conversational-correction:style_format'],
      })
    );
  });
});
