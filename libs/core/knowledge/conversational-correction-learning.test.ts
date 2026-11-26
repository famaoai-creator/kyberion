import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync } from '../secure-io.js';
import {
  listExecutionFeedbackCandidates,
  loadExecutionFeedbackStore,
} from './execution-feedback.js';
import { executionFeedbackScopeRoot } from './execution-feedback-candidates.js';
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

  it('blocks secrets and block-action PII before persistence and masks email/local paths', () => {
    const recordFeedback = vi.fn((input) => ({
      kind: 'execution-feedback' as const,
      schema_version: '1.0.0' as const,
      feedback_id: 'FB-2',
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
      candidate: { candidate_id: 'CAND-2', status: 'proposed' } as never,
    }));
    const validScope = { tier: 'confidential' as const, tenant_slug: 'acme' };

    const withApiKey = captureConversationalCorrectionLearning({
      text: 'Next time never include sk-1234567890abcdefghijklmnop in the report',
      scope: validScope,
      recordFeedback: recordFeedback as never,
      materializeCandidate: materializeCandidate as never,
    });
    expect(withApiKey.captured).toBe(false);
    expect(withApiKey.reason).toBe('sensitive_content_blocked');
    expect(withApiKey.blockedReasons).toContain('secret');
    expect(withApiKey.detection.normalizedRule).toBeUndefined();

    const withPem = captureConversationalCorrectionLearning({
      text: 'Next time summarize without -----BEGIN PRIVATE KEY----- headers',
      scope: validScope,
      recordFeedback: recordFeedback as never,
      materializeCandidate: materializeCandidate as never,
    });
    expect(withPem.captured).toBe(false);
    expect(withPem.reason).toBe('sensitive_content_blocked');
    expect(withPem.blockedReasons).toContain('PRIVATE_KEY');
    expect(recordFeedback).not.toHaveBeenCalled();
    expect(materializeCandidate).not.toHaveBeenCalled();

    const withEmailAndPath = captureConversationalCorrectionLearning({
      text: 'Next time keep bullet points short instead of emailing alice@example.com from /Users/alice/work',
      scope: validScope,
      recordFeedback: recordFeedback as never,
      materializeCandidate: materializeCandidate as never,
    });
    expect(withEmailAndPath.captured).toBe(true);
    expect(withEmailAndPath.feedback?.correction).not.toContain('alice@example.com');
    expect(withEmailAndPath.feedback?.correction).not.toContain('/Users/alice/');
    expect(withEmailAndPath.feedback?.correction).toContain('[REDACTED:EMAIL_ADDRESS]');
    expect(withEmailAndPath.feedback?.correction).toContain('[REDACTED_PATH]/');
    expect(withEmailAndPath.redactedRules).toContain('EMAIL_ADDRESS');
  });
});

describe('conversational-correction-learning real persistence path (IL-05)', () => {
  const queueRelPath = `active/shared/tmp/test-memory-queue-conv-learning-${process.pid}.jsonl`;
  const syntheticScope = {
    tier: 'confidential' as const,
    tenant_slug: 'synthetic-conv-learning',
  };
  let originalQueueEnv: string | undefined;

  beforeEach(() => {
    originalQueueEnv = process.env.KYBERION_MEMORY_QUEUE_PATH;
    process.env.KYBERION_MEMORY_QUEUE_PATH = queueRelPath;
    safeRmSync(pathResolver.rootResolve(queueRelPath), { force: true });
    safeRmSync(executionFeedbackScopeRoot(syntheticScope), { recursive: true, force: true });
  });

  afterEach(() => {
    if (originalQueueEnv === undefined) delete process.env.KYBERION_MEMORY_QUEUE_PATH;
    else process.env.KYBERION_MEMORY_QUEUE_PATH = originalQueueEnv;
    safeRmSync(pathResolver.rootResolve(queueRelPath), { force: true });
    safeRmSync(executionFeedbackScopeRoot(syntheticScope), { recursive: true, force: true });
  });

  it('never writes secrets or unredacted PII into persisted feedback or memory candidate stores', () => {
    const blockedSecret = captureConversationalCorrectionLearning({
      text: 'Next time avoid putting sk-1234567890abcdefghijklmnop into replies',
      scope: syntheticScope,
    });
    expect(blockedSecret.captured).toBe(false);
    expect(blockedSecret.reason).toBe('sensitive_content_blocked');

    const blockedPem = captureConversationalCorrectionLearning({
      text: 'Next time skip -----BEGIN PRIVATE KEY----- blocks',
      scope: syntheticScope,
    });
    expect(blockedPem.captured).toBe(false);
    expect(blockedPem.reason).toBe('sensitive_content_blocked');

    expect(loadExecutionFeedbackStore(syntheticScope).entries).toHaveLength(0);
    expect(listExecutionFeedbackCandidates(syntheticScope)).toHaveLength(0);

    const maskedResult = captureConversationalCorrectionLearning({
      text: 'Next time keep bullet points short instead of emailing alice@example.com from /Users/alice/work',
      scope: syntheticScope,
    });
    expect(maskedResult.captured).toBe(true);

    const entries = loadExecutionFeedbackStore(syntheticScope).entries;
    const candidates = listExecutionFeedbackCandidates(syntheticScope);
    const rawQueue = safeExistsSync(pathResolver.rootResolve(queueRelPath))
      ? String(safeReadFile(pathResolver.rootResolve(queueRelPath), { encoding: 'utf8' }))
      : '';

    expect(entries).toHaveLength(1);
    expect(candidates).toHaveLength(1);
    expect(JSON.stringify({ entries, candidates, rawQueue })).not.toContain('alice@example.com');
    expect(JSON.stringify({ entries, candidates, rawQueue })).not.toContain('/Users/alice/');
    expect(JSON.stringify({ entries, candidates, rawQueue })).toContain('[REDACTED:EMAIL_ADDRESS]');
    expect(JSON.stringify({ entries, candidates, rawQueue })).toContain('[REDACTED_PATH]/');
  });
});
