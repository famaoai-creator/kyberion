import { describe, expect, it } from 'vitest';
import { assessTaskDistillCandidate } from './task-distill-candidate.js';

describe('task-distill-candidate', () => {
  it('rejects generic document completions without reusable structure', () => {
    const result = assessTaskDistillCandidate({
      taskType: 'report_document',
      goalSummary: 'Report',
      previewText: 'レポート文書を生成しました。',
      artifactId: 'ART-1',
      hasWorkLoop: true,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/too generic/i);
  });

  it('accepts service operations with concrete operational detail', () => {
    const result = assessTaskDistillCandidate({
      taskType: 'service_operation',
      goalSummary: 'Restart presence surface',
      previewText: 'presence-surface を再起動しました。',
      artifactId: 'ART-2',
      hasWorkLoop: true,
    });

    expect(result.eligible).toBe(true);
    expect(result.targetKind).toBe('sop_candidate');
  });
});
